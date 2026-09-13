# Metadawn Studio

[![CI](https://github.com/metadawnstudiogba-droid/metadawn-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/metadawnstudiogba-droid/metadawn-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Metadawn Studio is a self-hosted video creation workspace with a browser UI. It supports declarative provider adapters, separate generation and asset-registration credentials, and a private Cloudflare R2 bucket owned by each user.

The local edition runs on macOS, Windows, and Linux without Docker, accounts, or cloud database setup. The hosted edition adds email accounts and PostgreSQL while keeping every user's provider and R2 credentials separate.

## What it provides

- Video generation, extension, editing, green-screen, and white-model workflows when supported by the selected provider.
- Built-in adapters for KKIDC and Volcengine Ark.
- Importable JSON adapters for other HTTPS APIs, without scripts or `eval`.
- Separate encrypted credentials for generation, asset registration, and R2.
- Durable output archiving to the user's private R2 bucket.
- Provider switching that preserves completed history and blocks changes while work is active.

## Local edition

Install [Node.js 24 LTS](https://nodejs.org/) and Git, then run:

```bash
git clone https://github.com/metadawnstudiogba-droid/metadawn-studio.git
cd metadawn-studio
npm ci
npm run setup:local
npm run start:local
```

Open `http://127.0.0.1:3030`. Enter provider and R2 credentials in **API 设置** inside the browser. The local edition does not require registration or login, and it does not read hosted-account data.

For backups, upgrades, custom ports, and agent-assisted installation, see [Local installation](docs/install-local.md).

## Install with a coding agent

Give Codex, Claude Code, or OpenCode this repository URL and the following request:

> Install the local edition of https://github.com/metadawnstudiogba-droid/metadawn-studio on this computer. Follow `AGENTS.md`, use Node.js 24 LTS, do not use Docker, preserve any existing Metadawn Studio data, and stop when the browser workspace is running. I will enter provider and R2 credentials in the web UI; do not request them in the terminal or chat.

## Hosted edition

The hosted edition requires PostgreSQL, Better Auth secrets, a Brevo sender, and scheduled background functions. Each account still supplies its own provider credentials and dedicated private R2 bucket through the web UI.

See [Hosted deployment](docs/hosted-deployment.md). Apply database changes on an isolated branch before production, and give the application only the restricted `seedance_runtime` connection.

## Provider adapters

Adapters are declarative JSON documents. The importer validates their schema, capabilities, credential purpose, HTTPS endpoints, request mappings, response mappings, size, and complexity before saving them. Network requests reject redirects and private addresses and pin the checked public DNS result.

Start with [the adapter guide](docs/provider-adapters.md) and the bundled examples in [`providers/`](providers/).

## Security and privacy

- Provider and R2 credentials are encrypted at rest and are never returned after saving.
- Generation and asset-registration credentials have separate declared purposes.
- Media is stored in the user's R2 bucket; PostgreSQL stores metadata and internal `r2://` references.
- Local data and hosted data are independent. Version 1 has no synchronization or migration between them.
- Back up the entire local data directory, including `master.key`. The database cannot be decrypted if that key is lost.

Report vulnerabilities through [GitHub private vulnerability reporting](SECURITY.md). Do not include secrets, signed URLs, or private media in an issue.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Pull requests are welcome and voluntary. Read [Contributing](CONTRIBUTING.md) before submitting changes.

Metadawn Studio is independent software and is not affiliated with ByteDance, Volcengine, KKIDC, Cloudflare, Brevo, or Neon. Product names belong to their respective owners.

## License

[MIT](LICENSE)
