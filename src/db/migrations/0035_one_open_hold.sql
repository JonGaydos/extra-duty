-- Open holds left behind by a lifted vendor (the double-submit race): the lift already ended the hold.
UPDATE "vendor_holds" SET "resolved_at" = now(), "outcome" = 'handled', "note" = 'Closed when one open hold per vendor was enforced: the vendor hold was already lifted.', "updated_at" = now()
WHERE "resolved_at" IS NULL AND "vendor_id" IN (SELECT "id" FROM "vendors" WHERE "payment_hold" = false);--> statement-breakpoint
-- Duplicate open holds of a vendor still on hold: the oldest stays open, so details keep the lock they had.
UPDATE "vendor_holds" h SET "resolved_at" = now(), "outcome" = 'handled', "note" = 'Closed when one open hold per vendor was enforced: duplicate of an earlier open hold.', "updated_at" = now()
WHERE h."resolved_at" IS NULL AND EXISTS (
  SELECT 1 FROM "vendor_holds" o
  WHERE o."vendor_id" = h."vendor_id" AND o."resolved_at" IS NULL AND (o."placed_at", o."id") < (h."placed_at", h."id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_holds_one_open_idx" ON "vendor_holds" USING btree ("vendor_id") WHERE "vendor_holds"."resolved_at" is null;
