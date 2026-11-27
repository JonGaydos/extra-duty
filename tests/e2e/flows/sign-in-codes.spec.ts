import type { Page } from "@playwright/test";
import { DESKTOP, PASSWORD, expect, one, type Person, test } from "../fixtures";

/** The password step, then where it lands: the code page, or signed in. */
async function passwordStep(page: Page, who: Person): Promise<"code" | "in"> {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname !== "/sign-in");
  return new URL(page.url()).pathname === "/two-factor" ? "code" : "in";
}

/** The sign-in settings are re-read at most every 30 seconds, so the new rule may take that long to apply. */
async function untilPasswordStepGives(page: Page, who: Person, want: "code" | "in"): Promise<void> {
  await expect.poll(() => passwordStep(page, who), { timeout: 45_000, intervals: [2_000, 5_000] }).toBe(want);
}

/**
 * Security, "Require emailed sign-in codes": the admin turns codes off for deputies after a warning, a deputy then
 * signs in with the password alone, the change is audited, and turning it back on asks for the code again.
 */
test("a deputy signs in without a code when the deputy switch is off", async ({ agency, session }) => {
  test.setTimeout(180_000);
  const admin = await session(agency.admin, { viewport: DESKTOP });
  const deputy = await session(agency.deputy, { viewport: DESKTOP });
  const form = admin.getByRole("form", { name: "Require emailed sign-in codes" });
  const deputies = form.getByRole("switch", { name: "Deputies" });

  try {
    await test.step("admins are locked on, with the reason", async () => {
      await admin.goto("/admin/system/security");
      await expect(form).toContainText("Admins can change the email server and security settings and export all data.");
      await expect(form.getByRole("switch", { name: "Admins" })).toHaveCount(0);
    });

    await test.step("turning deputies off warns first, then saves", async () => {
      await deputies.click();
      await expect(deputies).toHaveAttribute("aria-checked", "false");
      await form.getByRole("button", { name: "Save sign-in codes" }).click();
      const confirm = form.getByRole("region", { name: "Confirm sign-in without a code" });
      await expect(confirm).toContainText("W-9s with Social Security numbers and pay records");
      await confirm.getByRole("button", { name: "Turn off codes for Deputies" }).click();
      await expect(form.getByRole("status")).toContainText("Sign-in codes saved.");
      const audit = await one<{ after: { signInCodes: { personnel: boolean } } }>(
        "select after from audit_log where action = 'settings.sign_in_codes' and actor_user_id = $1 order by at desc limit 1",
        [agency.admin.id],
      );
      expect(audit.after.signInCodes.personnel).toBe(false);
    });

    await test.step("the deputy signs in with the password alone", async () => {
      await untilPasswordStepGives(deputy, agency.deputy, "in");
      await expect(deputy).toHaveURL(/\/home$/);
    });
  } finally {
    await test.step("codes back on for deputies, and the code step returns", async () => {
      await admin.goto("/admin/system/security");
      if ((await deputies.getAttribute("aria-checked")) === "false") {
        await deputies.click();
        await form.getByRole("button", { name: "Save sign-in codes" }).click();
        await expect(form.getByRole("status")).toContainText("Sign-in codes saved.");
      }
      await untilPasswordStepGives(deputy, agency.deputy, "code");
    });
  }
});
