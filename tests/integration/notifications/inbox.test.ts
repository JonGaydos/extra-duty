import { describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { messageRecipients, messages, notifications } from "@/db/schema";
import { listAlerts, markAllAlertsRead, unreadAlertCount } from "@/domain/notifications/inbox";
import { markRead } from "@/domain/notifications/prefs";
import { MESSAGE_PAGE_SIZE, unreadMessageCount } from "@/domain/messages/messages";
import { makeUser } from "../users/helpers";

describe("alerts inbox and unread counts", () => {
  const get = useTestDb();

  test("lists only the person's alerts, newest first, with safe in-app links; marks one and all read", async () => {
    const { db } = get();
    const me = (await makeUser(db, "personnel", "inbox1@example.test")).actor;
    const other = (await makeUser(db, "personnel", "inbox2@example.test")).actor;
    const t = (m: number) => new Date(Date.UTC(2035, 0, 1, 12, m));
    await db.insert(notifications).values([
      { userId: me.userId, type: "job.changed", title: "Older", link: "/jobs/abc", createdAt: t(1) },
      { userId: me.userId, type: "job.changed", title: "Newer", link: "https://evil.example/x", createdAt: t(2) },
      { userId: me.userId, type: "job.changed", title: "Protocol relative", link: "//evil.example", createdAt: t(3) },
      { userId: other.userId, type: "job.changed", title: "Not mine", link: "/jobs/x", createdAt: t(4) },
    ]);
    const list = await db.transaction((tx) => listAlerts(me, tx));
    expect(list.map((a) => a.title)).toEqual(["Protocol relative", "Newer", "Older"]);
    expect(list.map((a) => a.link)).toEqual([null, null, "/jobs/abc"]);
    expect(await db.transaction((tx) => unreadAlertCount(me, tx))).toBe(3);
    await db.transaction((tx) => markRead(me, tx, [list[2].id]));
    expect(await db.transaction((tx) => unreadAlertCount(me, tx))).toBe(2);
    expect(await db.transaction((tx) => markAllAlertsRead(me, tx))).toBe(2);
    expect(await db.transaction((tx) => unreadAlertCount(me, tx))).toBe(0);
    expect(await db.transaction((tx) => unreadAlertCount(other, tx))).toBe(1);
  });

  test("the unread message count is a true count, past one page", async () => {
    const { db } = get();
    const me = (await makeUser(db, "personnel", "inbox3@example.test")).actor;
    const sender = (await makeUser(db, "coordinator", "inbox4@example.test")).actor;
    for (let i = 0; i < MESSAGE_PAGE_SIZE + 3; i++) {
      const [m] = await db.insert(messages).values({ senderUserId: sender.userId, subject: `S${i}`, body: "b", recipientCount: 1 }).returning();
      await db.insert(messageRecipients).values({ messageId: m.id, userId: me.userId, hiddenAt: i === 0 ? new Date() : null });
    }
    expect(await db.transaction((tx) => unreadMessageCount(me, tx))).toBe(MESSAGE_PAGE_SIZE + 2);
  });
});
