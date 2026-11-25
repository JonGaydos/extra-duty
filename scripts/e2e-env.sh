# Sourced by scripts/e2e-ui.sh. Uses browsers installed without root when they are present (as in a container
# without system browser libraries): the Chromium headless shell and its libraries, and Firefox with its GTK libraries, which adds the
# Firefox projects. Values already set in the environment win.
pw="$HOME/.cache/ms-playwright"
shell=$(ls -d "$pw"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | tail -n 1 || true)
if [ -z "${E2E_CHROMIUM:-}" ] && [ -n "$shell" ]; then export E2E_CHROMIUM="$shell"; fi
libs=""
[ -d "$HOME/.local/chrome-libs/root/usr/lib/x86_64-linux-gnu" ] && libs="$HOME/.local/chrome-libs/root/usr/lib/x86_64-linux-gnu"
firefox=$(ls -d "$pw"/firefox-*/firefox 2>/dev/null | tail -n 1 || true)
if [ -n "$firefox" ] && [ -d "$HOME/.local/ff-libs/root" ] && [ -z "${E2E_FIREFOX+set}" ]; then
  export E2E_FIREFOX=1 MOZ_DISABLE_CONTENT_SANDBOX=1
  libs="$firefox:$HOME/.local/ff-libs/root:$HOME/.local/ff-libs/root/usr/lib/x86_64-linux-gnu${libs:+:$libs}"
fi
if [ -n "$libs" ]; then export LD_LIBRARY_PATH="$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
# The test app and its database get ports of their own, clear of a preview on 3210.
export E2E_PORT="${E2E_PORT:-3220}" E2E_DB_PORT="${E2E_DB_PORT:-54339}"
