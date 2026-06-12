# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Repo Search

When investigating this repository, prefer Qdrant MCP search before workspace full-text search.

Start with `qdrant-find` using the templates in `docs/QDRANT_QUERY_TEMPLATES.md`.

Use two-step retrieval when possible: first by feature intent, then by `links` tokens such as `belongs_to`, `tested_by`, `related_doc`, and `imports`.

Use workspace full-text search only for exact symbol checks, line-level verification, or when Qdrant is unavailable, stale, or returns weak results.

If recent changes may not be indexed yet, refer to `docs/QDRANT_QUERY_TEMPLATES.md` for refresh and validation workflow before relying on retrieval.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `wrangler dev` | Local development |
| `wrangler deploy` | Deploy to Cloudflare |
| `wrangler types` | Generate TypeScript types |

If shim resolution is unstable, prefer running commands via `mise exec -- <command>`.

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
