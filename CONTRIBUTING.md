# Contributing

Contributions are welcome and voluntary. Opening an issue does not create an obligation for a maintainer or contributor to implement it.

## Before opening a pull request

1. Use Node.js 24 LTS and install the locked dependency tree with `npm ci`.
2. Keep credentials, connection strings, signed URLs, private media, and local workspace data out of commits and test output.
3. Make the smallest change that solves the issue. Preserve existing user data and provider history.
4. Run `npm test`, `npm run typecheck`, and `npm run build`.
5. Explain the user-visible result and any provider behavior that could not be tested with a real account.

Provider adapters must remain declarative JSON. Templates containing scripts, executable expressions, redirects, non-HTTPS endpoints, or credentials used outside their declared purpose will not be accepted.

Use fake credentials and public example domains in tests. A passing contract test does not prove that a provider account, paid API, email sender, database migration, or deployment works in production.

Security reports belong in a private GitHub security advisory, as described in [SECURITY.md](SECURITY.md), rather than a public issue.
