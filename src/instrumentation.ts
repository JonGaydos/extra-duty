export async function register(): Promise<void> {
  // A positive check lets the bundler drop the Node-only import from the edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { cleanEnv } = await import("./lib/env-clean");
    cleanEnv();
    const { ensureEmailSender } = await import("./bootstrap/email");
    ensureEmailSender();
  }
}
