# Contributing

Thank you for helping. Bug reports, fixes and improvements are welcome. For a security problem, follow
[SECURITY.md](SECURITY.md) instead of opening an issue.

## Getting started

Requires Node 24 or newer.

    npm install
    npm rebuild embedded-postgres @embedded-postgres/linux-x64

Copy `app.env.example` to `.env.local` and fill in values. `npm run dev` starts the app on http://localhost:3000.

## Running the tests

    npm run test:unit          # fast unit tests
    npm run test:integration   # starts a throwaway Postgres; no database setup needed
    npm run test:e2e           # Playwright; builds the app into .next-e2e and seeds its own database
    npx tsc --noEmit           # type check
    npm run lint               # ESLint
    npm run lint:sonar         # SonarCloud rules, about 2 minutes

Run the unit and integration tests, the type check and the linter before opening a pull request. Add or update
tests for every change in behavior. Run the end-to-end specs that cover the screens you changed, for example
`npm run test:e2e -- tests/e2e/vendor.spec.ts`.

## Code style

- TypeScript throughout. Follow the existing patterns in the files you touch, and keep changes focused.
- Business rules live in `src/domain`, with role checks and audit logging. Pages and API routes call into it.
- Schema changes go in `src/db/schema`, followed by `npm run db:generate` for the migration.
- Screens follow [DESIGN.md](DESIGN.md) and [PRODUCT.md](PRODUCT.md): phone and desktop, day and night themes,
  WCAG 2.2 AA.
- Interface copy is plain and professional, with no emojis.
- Commit messages are a one-line imperative subject ("Add a vendor filter to reports").
- Agency-specific values (name, address, rates, rules) are settings, never code.
- Never commit secrets, real personal data or real agency data. Tests and demo data use made-up names and
  addresses ending in `.example` or `.test`.

## License

By contributing, you agree that your contributions are licensed under the GNU Affero General Public License,
version 3 only, the same as the project ([LICENSE](LICENSE)).
