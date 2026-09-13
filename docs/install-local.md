# Local installation

The local edition runs on macOS, Windows, and Linux. It binds only to `127.0.0.1`, has no registration or login flow, and keeps its database and encrypted credentials on this computer.

## Requirements

- Node.js 24 LTS
- Git
- A provider account supported by a built-in or imported adapter
- A dedicated private Cloudflare R2 bucket with S3-compatible read and write credentials

Docker is not used.

## Install

```bash
git clone https://github.com/metadawnstudiogba-droid/metadawn-studio.git
cd metadawn-studio
npm ci
npm run setup:local
npm run start:local
```

Open `http://127.0.0.1:3030`, then configure the provider and R2 bucket in **API 设置**. Credentials are encrypted before they are stored locally.

To use another port during the first setup:

```bash
npm run setup:local -- --port 3031
npm run start:local
```

## Check an installation

```bash
npm run doctor:local
```

The check reports the Node.js version, local data directory, workspace configuration, encryption-key status, URL, and whether a production build exists. It does not print credentials.

## Data and backups

Default data locations are:

| System | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/MetadawnStudio` |
| Windows | `%LOCALAPPDATA%\MetadawnStudio` |
| Linux | `$XDG_DATA_HOME/metadawn-studio` or `~/.local/share/metadawn-studio` |

Stop the program before backing up or restoring. Copy the entire directory, including `workspace.json`, `master.key`, and the `postgres` directory. Losing `master.key` makes saved credentials unreadable; creating a replacement key does not recover them.

Set `STUDIO_DATA_DIR` to an absolute path to use a different location. Do not point two running processes at the same directory; the second process will stop without modifying it.

## Upgrade

1. Stop the local program and back up the full data directory.
2. Pull the new source version.
3. Run `npm ci` and `npm run setup:local`.
4. Run `npm run start:local` and confirm that existing history appears.

The setup command applies idempotent schema changes and refuses to silently create an empty database when an initialized workspace is incomplete.

## Agent-assisted installation

Send a coding agent this request:

> Install the local edition of https://github.com/metadawnstudiogba-droid/metadawn-studio on this computer. Follow `AGENTS.md`, use Node.js 24 LTS, do not use Docker, preserve any existing Metadawn Studio data, and stop when the browser workspace is running. I will enter provider and R2 credentials in the web UI; do not request them in the terminal or chat.
