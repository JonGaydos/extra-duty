import { PassThrough, Readable } from "node:stream";
import { createDeflateRaw, crc32 } from "node:zlib";

export type ZipEntry = { name: string; chunks: AsyncIterable<string | Buffer> };

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_AND_DESCRIPTOR = 0x0808;
const DEFLATE = 8;

/**
 * Writes the entries as a zip, one at a time and in order, without knowing any size up front: each entry is
 * deflated as it streams and followed by a data descriptor; the central directory comes last. Under 4 GB (no zip64).
 */
export async function writeZip(entries: AsyncIterable<ZipEntry>, emit: (b: Buffer) => Promise<void>): Promise<void> {
  let offset = 0;
  let count = 0;
  const central: Buffer[] = [];
  const out = async (b: Buffer) => {
    offset += b.length;
    await emit(b);
  };
  const { time, date } = dosTime(new Date());
  for await (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await out(Buffer.concat([local, name]));

    let crc = 0;
    let size = 0;
    let csize = 0;
    const deflate = createDeflateRaw();
    const pump = (async () => {
      for await (const c of deflate as AsyncIterable<Buffer>) {
        csize += c.length;
        await out(c);
      }
    })();
    for await (const chunk of entry.chunks) {
      const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      crc = crc32(b, crc);
      size += b.length;
      if (!deflate.write(b)) await new Promise((r) => deflate.once("drain", r));
    }
    deflate.end();
    await pump;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(csize, 8);
    descriptor.writeUInt32LE(size, 12);
    await out(descriptor);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
    c.writeUInt16LE(DEFLATE, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(start, 42);
    central.push(Buffer.concat([c, name]));
    count++;
  }
  const directory = Buffer.concat(central);
  const directoryStart = offset;
  await out(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryStart, 16);
  await out(end);
}

/**
 * A web stream fed by `produce`, with backpressure: `emit` waits while the reader is behind. If the reader goes
 * away, `emit` throws so the producer (and its transaction) stops.
 */
export function streamFrom(produce: (emit: (b: Buffer) => Promise<void>) => Promise<void>): ReadableStream<Uint8Array> {
  const pass = new PassThrough();
  const emit = async (b: Buffer) => {
    if (pass.destroyed) throw new Error("The download was closed.");
    if (!pass.write(b)) {
      await new Promise<void>((r) => {
        pass.once("drain", r);
        pass.once("close", r);
      });
      if (pass.destroyed) throw new Error("The download was closed.");
    }
  };
  produce(emit).then(
    () => pass.end(),
    (e: unknown) => pass.destroy(e instanceof Error ? e : new Error(String(e))),
  );
  return Readable.toWeb(pass) as ReadableStream<Uint8Array>;
}
