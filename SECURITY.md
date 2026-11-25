# Security Policy

Extra Duty holds sensitive records: W-9 forms with Social Security numbers, sign-in codes, vendor billing details and
an audit log. Please report security problems privately so they can be fixed before they are public.

## Reporting a vulnerability

Use GitHub private vulnerability reporting:

1. Open this repository on GitHub and go to the **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, the affected version or commit, and the steps to reproduce it. Include what an attacker
   could reach (for example another user's data, W-9 files or admin settings).

Do not open a public issue, pull request or discussion for a vulnerability.

You should get a first reply within 7 days. The fix and an advisory are published together once a patched version
is available, and reporters are credited unless they ask not to be.

## Scope

In scope: the code in this repository, including the web app, the worker, the API, the Docker image and the Docker
Compose setup.

Out of scope: problems in an agency's own hosting (server, network, email account or backups), and findings that
need an already compromised admin account or server.

## Supported versions

Only the latest release on the default branch gets security fixes.
