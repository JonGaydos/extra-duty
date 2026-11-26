/**
 * A sync sequence served as an async one, one item per `next()`, the way a streamed response body arrives. Test
 * fakes use it so a body needs no async generator with nothing to wait for.
 *
 * Given a generator, it can be read once: a generator returns itself as its iterator, so a second `for await`
 * gets nothing. Build a new one for each read.
 */
export function asAsync<T>(items: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const it = items[Symbol.iterator]();
      return { next: () => Promise.resolve(it.next()) };
    },
  };
}
