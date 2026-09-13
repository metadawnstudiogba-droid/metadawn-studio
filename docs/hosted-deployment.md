# Hosted deployment

Hosted mode adds accounts, email verification, PostgreSQL persistence, and scheduled reconciliation. Provider and R2 credentials remain user supplied through the browser UI.

## Components

- Node.js 24 hosting with support for Next.js server routes and background work
- PostgreSQL with a privileged migration connection and a separate restricted runtime role
- Brevo transactional email for verification and password resets
- Cloudflare R2 buckets supplied independently by each user

The repository includes Netlify scheduled and background functions. Other platforms need equivalent protected scheduling for pending-task reconciliation.

## Database boundary

Create `seedance_runtime` with [`db/create-runtime-role.sql`](../db/create-runtime-role.sql), then apply [`db/schema.sql`](../db/schema.sql) using the owner connection. Generate a unique runtime password and pass it through a secret-capable, transaction-local parameter; never place it in source, command arguments, CI logs, or migration reports.

The application receives only the pooled `seedance_runtime` URL. Keep the owner URL outside the hosting platform. The tenant tables force row-level security, and each application transaction sets `app.user_id` from the verified session.

Apply and test schema changes first on an isolated database branch. Verify role attributes, grants, forced row-level security, tenant separation, and existing row counts before production.

## Environment

Copy `.env.example` into the hosting provider's encrypted environment settings. Required hosted values are:

- `DATABASE_URL`: pooled restricted runtime connection
- `SETTINGS_ENCRYPTION_KEY`: independent random encryption key
- `BETTER_AUTH_SECRET`: independent random authentication secret
- `BETTER_AUTH_URL`: exact public HTTPS origin
- `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`
- `CRON_SECRET`: independent random background-function secret

Do not configure user provider or R2 credentials as deployment environment variables.

## Cloudflare R2

Each user connects a dedicated, private, empty bucket. Public `r2.dev` access should remain disabled. Update [`cloudflare/r2-cors.json`](../cloudflare/r2-cors.json) with the exact hosted origin before giving the rule to users.

The UI verifies server read/write access and browser CORS separately. A successful object probe confirms connectivity; it cannot prove that a token is limited to only one bucket, so users must verify the scope in Cloudflare.

## Release checks

Run `npm test`, `npm run typecheck`, and `npm run build`. Then verify account creation, email verification, provider setting save/read, R2 upload and CORS, generation submission, background reconciliation, durable download, and tenant isolation in the deployed environment.

Keep local validation, database-branch validation, production migration, deployment, and Git push results separate in release records.
