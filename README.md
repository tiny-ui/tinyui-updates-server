# tinyui-updates-server

English | [简体中文](./README.zh-CN.md)

Hot update delivery and publishing for [TinyUI](https://github.com/tiny-ui/tinyui) packages: the reference implementation of the protocol in the TinyUI repo's `docs/updates.md`, running on Cloudflare Workers. The hosted instance is `updates.tinyui.app`; self-hosting is deploying this same code to your own Cloudflare account.

The server is a carrier, not a trust anchor. Packages are signed by their publisher (`tinyui bundle --signing-key`); the server verifies the signature with the key registered for the package before it publishes, and every client verifies it again with the key embedded in the App. A leaked publish token cannot produce a package clients accept, and a compromised server cannot either.

## What it serves

Two kinds of `GET`, relative to `https://<host>/<app>/<channel>`:

| Path | Content | Cache |
|---|---|---|
| `<pkg>/<rv>/current.json` | mutable pointer: `{ version, rollout, signature }` | `no-store` |
| `<pkg>/<rv>/<version>/…` | immutable content: `manifest.json`, `runtime/*.bin`, `pages/**/*.bin` | `immutable` |

Content is stored once per `(app, pkg, rv, version)`; a channel is only a pointer, so promoting a verified version from `staging` to `production` moves the pointer and transfers nothing.

## Publishing

All requests carry `Authorization: Bearer <token>`.

| Request | Meaning |
|---|---|
| `PUT /<app>/<pkg>/<rv>/<version>/<path>` | upload one file (idempotent; different bytes at an existing path → 409) |
| `PUT /<app>/<channel>/<pkg>/<rv>/current.json` with `{ version, signature, rollout? }` | publish: verifies the signature over the uploaded `manifest.json` with the registered key, checks `name` / `runtimeVersion` / `version` / `publicKey` and every file's sha256, records the release, moves the pointer |
| `GET /<app>/<pkg>/<rv>/releases` | published versions and where each channel points |
| `POST /<app>/<channel>/<pkg>/<rv>/pointer` with `{ version?, rollout? }` | rollback, promotion and rollout changes are the same operation |

`tinyui publish` / `tinyui releases …` in `tinyui-cli` are thin clients of these endpoints.

## Management (`ADMIN_TOKEN`)

| Request | Meaning |
|---|---|
| `POST /apps` `{ id, name, org? }` | create an app (`id` is a path segment; `org` is for billing only) |
| `POST /apps/<app>/packages` `{ name, publicKey }` | register a package and its verification key |
| `PUT /apps/<app>/packages/<pkg>/publicKey` | rotate the key |
| `POST /apps/<app>/packages/<pkg>/tokens` `{ channels }` | issue a publish token limited to channels; returned once, stored as a hash |
| `DELETE /apps/<app>/packages/<pkg>/tokens/<id>` | revoke |

## Self-hosting

Cloudflare Workers with one R2 bucket (the paid plan's lowest tier is enough). R2 holds both the package content and the metadata: it is strongly consistent, so a revoked token stops working at once and a published pointer is served at once.

1. Fork or clone. Create an R2 bucket and put its name into `wrangler.toml`.
2. `npx wrangler secret put ADMIN_TOKEN`
3. `pnpm install && pnpm deploy`; optionally connect the repo in the Cloudflare dashboard so a push deploys.
4. `tinyui apps create …`, `tinyui packages create …`, `tinyui tokens create …` against your host, then point each App's `fetch` base at `https://<host>/<app>/<channel>`.

The hosted instance (custom domain `updates.tinyui.app`) is deployed by Cloudflare Workers Builds on every push to `main`, running `wrangler deploy --config wrangler.tinyui.toml`; `wrangler.toml` stays the generic template.

Local run: `pnpm dev` (`.dev.vars` holds `ADMIN_TOKEN`, see `.dev.vars.example`). Tests: `pnpm test` (Workers runtime with R2 emulated).

Storage sits behind `src/storage.ts`'s `Storage` interface: `R2Storage` for Cloudflare, `MemoryStorage` for tests and other runtimes.

## License

[MIT](./LICENSE)
