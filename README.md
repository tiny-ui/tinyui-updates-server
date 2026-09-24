# tinyui-updates-server

English | [简体中文](./README.zh-CN.md)

Hot update delivery and publishing for [TinyUI](https://github.com/tiny-ui/tinyui) packages: the reference implementation of the protocol in the TinyUI repo's `docs/updates.md`, running on Cloudflare Workers. The hosted instance is `updates.tinyui.app`; self-hosting is deploying this same code to your own Cloudflare account.

The server is a carrier, not a trust anchor. Packages are signed by their publisher (`tinyui bundle --signing-key`); the server verifies the signature with the key registered for the package before it publishes, and every client verifies it again with the key embedded in the App. A leaked publish token cannot produce a package clients accept, and a compromised server cannot either.

## What it serves

Two kinds of `GET`, relative to `https://<host>/<app>/<channel>`:

| Path | Content | Cache |
|---|---|---|
| `<pkg>/<hostVersion>/current.json` | mutable pointer: `{ version, rollout, signature }` | `no-store` |
| `<pkg>/<hostVersion>/<version>/…` | immutable content: `manifest.json`, `runtime/*.bin`, `pages/**/*.bin` | `immutable` |

`<hostVersion>` is the positive integer a host App declares for what it provides to pages: it goes up when host components or capabilities change or the embedded TinyUI is upgraded. It is not the version of the TinyUI runtime or the JS engine (the manifest's `engine` / `protocol` cover those); it plays the role of Expo's `runtimeVersion` but is always a positive integer that counts host changes, never an App version such as `1.2.0`; see the TinyUI repo's `docs/updates.md`.

Content is stored once per `(app, pkg, hostVersion, version)`; a channel is only a pointer, so promoting a verified version from `staging` to `production` moves the pointer and transfers nothing.

## Publishing

All requests carry `Authorization: Bearer <token>`.

| Request | Meaning |
|---|---|
| `PUT /<app>/<pkg>/<hostVersion>/<version>/<path>` | upload one file (idempotent; different bytes at an existing path → 409) |
| `PUT /<app>/<channel>/<pkg>/<hostVersion>/current.json` with `{ version, signature, rollout? }` | publish: verifies the signature over the uploaded `manifest.json` with the registered key, checks `name` / `hostVersion` / `version` / `publicKey` and every file's sha256, records the release, moves the pointer |
| `GET /<app>/<pkg>/<hostVersion>/releases` | published versions and where each channel points |
| `POST /<app>/<channel>/<pkg>/<hostVersion>/pointer` with `{ version?, rollout? }` | promotion and rollout changes; the pointer only moves to a newer version (a rollback is a new version with the old content), 409 otherwise |

`tinyui publish` / `tinyui releases …` in `tinyui-cli` are thin clients of these endpoints.

## Management

An **app** is one host App: paths, host versions, snapshots and permissions hang off it. Its owner for billing (`org`, the tenant) can be renamed or transferred, so it appears in no path and grants nothing; one tenant may own several apps.

Three layers of credentials, each issued by the one above:

| Credential | Reaches | Issued by |
|---|---|---|
| the instance's `ADMIN_TOKEN` | every app; the only one that creates apps and issues app tokens | `wrangler secret put` |
| app token | everything under one app: packages, keys, publish tokens, releases, host snapshots | `ADMIN_TOKEN` |
| publish token | one package, limited to channels; can read its app's host snapshots | `ADMIN_TOKEN` or an app token of that app |

| Request | Credential | Meaning |
|---|---|---|
| `POST /apps` `{ id, name, org? }` | admin | create an app (`id` is a path segment) |
| `POST /apps/<app>/tokens` | admin | issue an app token; returned once, stored as a hash |
| `DELETE /apps/<app>/tokens/<id>` | admin | revoke it; an app token cannot mint or revoke app tokens |
| `POST /apps/<app>/packages` `{ name, publicKey }` | admin or app token | register a package and its verification key |
| `PUT /apps/<app>/packages/<pkg>/publicKey` | admin or app token | rotate the key |
| `POST /apps/<app>/packages/<pkg>/tokens` `{ channels }` | admin or app token | issue a publish token limited to channels; returned once, stored as a hash |
| `DELETE /apps/<app>/packages/<pkg>/tokens/<id>` | admin or app token | revoke |
| `PUT /apps/<app>/hosts/<hostVersion>` (snapshot bytes) | admin or app token | the host's CI uploads what that host version provides; written once, different bytes → 409 |
| `GET /apps/<app>/hosts/<hostVersion>` | any token of the app | read it back; `tinyui bundle` checks a package against it before signing |

None of these reach the clients' trust: devices verify with the key embedded in the App.

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
