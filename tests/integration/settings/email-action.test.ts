import { beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import type { Actor } from "@/domain/actor";
import { getSettings } from "@/domain/settings/settings";
import type { RequestContext } from "@/domain/training/mode";
import { decryptSecret } from "@/lib/crypto/secrets";
import { runInRequest } from "@/ui/shell/request";
import { saveEmailAction, type EmailForm } from "@/app/(app)/admin/system/_system/actions";

describe("saveEmailAction: the write-only API key", () => {
  const get = useTestDb();
  let admin: Actor;
  beforeAll(async () => {
    admin = (await makeUser(get().db, "admin", "email-admin@example.test")).actor;
  });

  const form = (apiKey: string): EmailForm => ({
    provider: "postmark",
    from: "Extra Duty <noreply@agency.example>",
    host: "",
    port: "",
    secure: false,
    user: "",
    password: "",
    clearPassword: false,
    apiKey,
    clearApiKey: false,
    region: "",
  });

  const save = (f: EmailForm) => {
    const ctx: RequestContext = { sessionId: "test", user: admin, actor: admin, mode: "live", practiceRole: null, run: (fn) => get().db.transaction(fn) };
    return runInRequest(ctx, () => saveEmailAction(f));
  };
  const savedKey = async () => {
    const enc = (await get().db.transaction((tx) => getSettings(tx))).email.apiKeyEnc;
    return enc ? decryptSecret(enc) : "";
  };

  test("a new key replaces the saved one, trimmed", async () => {
    expect(await save(form(" first-key "))).toMatchObject({ ok: true });
    expect(await savedKey()).toBe("first-key");
    expect(await save(form("second-key"))).toMatchObject({ ok: true });
    expect(await savedKey()).toBe("second-key");
  });

  test("a blank key keeps the saved one", async () => {
    expect(await save(form(""))).toMatchObject({ ok: true });
    expect(await savedKey()).toBe("second-key");
  });

  test("a key of only spaces keeps the saved one", async () => {
    expect(await save(form("   "))).toMatchObject({ ok: true });
    expect(await savedKey()).toBe("second-key");
  });
});
