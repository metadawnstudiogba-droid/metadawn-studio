# Provider adapter guide

Metadawn Studio provider adapters are declarative JSON documents. They describe capabilities, credentials, endpoints, request bodies, authentication, and response mappings. They cannot run code.

Use [`providers/kkidc.json`](../providers/kkidc.json) and [`providers/volcengine-ark.json`](../providers/volcengine-ark.json) as complete examples.

## Import and export

Open **API 设置**, select **导入 JSON 模板**, review the endpoint addresses, enter your credentials, and save. The server validates the template again before persisting it. Use **导出模板** to share a template; exported files contain the adapter definition and no saved credentials.

## Required structure

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `id`, `name`, `version` | Stable adapter identity and human-readable metadata. |
| `endpoints` | HTTPS base URLs for `generation` and optional `assets`. |
| `credentials` | Named fields, each restricted to one endpoint purpose. |
| `parameters` | Optional non-secret provider settings. |
| `models`, `capabilities` | Supported modes, sizes, ratios, duration, audio, and reference limits. |
| `operations` | Generation submission/status operations and an optional asset-registration pair. |

`createGeneration` and `getTask` are required. `registerAsset` and `getAsset` must either both exist or both be absent. Missing capabilities are disabled in the UI.

## Declarative values

Request body and query mappings support four operators:

- `{ "$ref": "input.prompt" }` reads a value from the permitted context.
- `{ "$string": "Task: {{input.prompt}}" }` interpolates permitted values.
- `{ "$map": "references", "value": ... }` maps a bounded reference list.
- `{ "$lookup": ..., "values": { ... }, "default": ... }` maps enum-like values.

JavaScript, shell commands, network calls from templates, `eval`, prototype keys, absolute operation URLs, and parent-path traversal are rejected.

## Authentication and credential separation

Supported authentication types are `bearer`, named `header`, named `query`, and Volcengine request signing. Every authentication field must reference a credential declared for the same `generation` or `assets` purpose. Generation secrets are unavailable to asset operations and vice versa.

## Network boundary

Endpoints must use HTTPS on port 443 without embedded credentials or query strings. Requests reject redirects, localhost, private networks, mixed public/private DNS answers, oversized JSON responses, and DNS rebinding after validation. The connection is pinned to the validated public address.

## Contribution checklist

1. Remove all real credentials, account IDs, task IDs, signed URLs, and private media references.
2. Validate the template through the web importer.
3. Add contract tests for request construction and response states.
4. Test failure and pending states as well as success.
5. State which operations were verified against a real provider account and which remain contract-only.
