# Repository instructions

## Local installation

- Use Node.js 24 LTS and the checked-in `package-lock.json`.
- Do not use Docker. Run `npm ci`, `npm run setup:local`, then `npm run start:local`.
- Preserve an existing local data directory. Never delete, replace, or regenerate `master.key` for an initialized workspace.
- Do not request provider, R2, database, or email credentials in chat or terminal output. The user enters provider and R2 credentials in the web UI.
- Confirm success by opening the loopback URL printed by the program. Local mode has no registration or login screen.

## Changes

- Provider adapters stay declarative JSON; do not add scripts, `eval`, or executable template fields.
- Preserve credential-purpose separation, public-address validation, redirect rejection, and tenant isolation.
- Use fake credentials in tests. Run `npm test`, `npm run typecheck`, and `npm run build` before handing off a change.
- Treat local validation, hosted database validation, deployment, and Git pushes as separate results.
