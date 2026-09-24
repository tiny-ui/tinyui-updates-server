# tinyui-updates-server

[English](./README.md) | 简体中文

[TinyUI](https://github.com/tiny-ui/tinyui) 包的热下发投递与发布服务：TinyUI 仓 `docs/updates.md` 协议的参考实现，跑在 Cloudflare Workers 上。托管实例是 `updates.tinyui.app`；私有化就是把同一份代码部署到自己的 Cloudflare 账号。

服务只是搬运工，不是信任锚。包由发布方签名（`tinyui bundle --signing-key`），服务端在发布时用该包登记的公钥验签，客户端再用 App 内置的公钥验一次。发布 token 泄露发不出客户端认的包，服务端被攻破也发不出。

## 投递什么

两类 `GET`，相对 `https://<host>/<app>/<channel>`：

| 路径 | 内容 | 缓存 |
|---|---|---|
| `<pkg>/<hostVersion>/current.json` | 可变指针：`{ version, rollout, signature }` | `no-store` |
| `<pkg>/<hostVersion>/<version>/…` | 不可变内容：`manifest.json`、`runtime/*.bin`、`pages/**/*.bin` | `immutable` |

`<hostVersion>` 是宿主 App 为"它给页面提供了什么"声明的正整数：宿主组件、宿主能力增删或改动，或者升级了内置的 TinyUI，都加 1。它不是 TinyUI 运行时或 JS 引擎的版本（那两者由 manifest 的 `engine` / `protocol` 校验），作用同 Expo 的 `runtimeVersion`，但取值只能是正整数、数的是宿主的变化，不是 `1.2.0` 这类 App 版本号，见 TinyUI 仓的 `docs/updates.md`。

内容按 `(app, pkg, hostVersion, version)` 存一份；channel 只是指针，staging 验过的版本晋级到 production 只动指针，不重传。

## 发布

所有请求带 `Authorization: Bearer <token>`。

| 请求 | 语义 |
|---|---|
| `PUT /<app>/<pkg>/<hostVersion>/<version>/<path>` | 上传一个文件（幂等；同路径不同内容 → 409） |
| `PUT /<app>/<channel>/<pkg>/<hostVersion>/current.json`，body `{ version, signature, rollout? }` | 发布：用登记的公钥对已上传的 `manifest.json` 原始字节验签，核对 `name` / `hostVersion` / `version` / `publicKey` 与每个文件的 sha256，记录 release，切指针 |
| `GET /<app>/<pkg>/<hostVersion>/releases` | 已发布的版本与各 channel 的指针 |
| `POST /<app>/<channel>/<pkg>/<hostVersion>/pointer`，body `{ version?, rollout? }` | 晋级、改灰度；指针只往更新的版本走（回滚是用旧内容发一个新版本），否则 409 |

`tinyui-cli` 的 `tinyui publish` / `tinyui releases …` 是这些端点的薄封装。

## 管理

**app** 是一个宿主 App：路径、宿主版本、快照与权限都挂在它上面。它的计费归属（`org`，即租户）可以改名、转让，所以不进路径、不带权限；一个租户可以有多个 app。

凭据三层，下层由上层签发：

| 凭据 | 范围 | 签发者 |
|---|---|---|
| 实例的 `ADMIN_TOKEN` | 所有 app；只有它能建 app、签发 app token | `wrangler secret put` |
| app token | 一个 app 下的一切：包、公钥、发布 token、release、宿主快照 | `ADMIN_TOKEN` |
| 发布 token | 一个包，限定 channel；可读本 app 的宿主快照 | `ADMIN_TOKEN` 或本 app 的 app token |

| 请求 | 凭据 | 语义 |
|---|---|---|
| `POST /apps` `{ id, name, org? }` | admin | 建 app（`id` 是路径段） |
| `POST /apps/<app>/tokens` | admin | 签发 app token；只返回一次，服务端只存哈希 |
| `DELETE /apps/<app>/tokens/<id>` | admin | 吊销；app token 不能签发或吊销 app token |
| `POST /apps/<app>/packages` `{ name, publicKey }` | admin 或 app token | 登记包与其验签公钥 |
| `PUT /apps/<app>/packages/<pkg>/publicKey` | admin 或 app token | 轮换公钥 |
| `POST /apps/<app>/packages/<pkg>/tokens` `{ channels }` | admin 或 app token | 签发限定 channel 的发布 token；只返回一次，服务端只存哈希 |
| `DELETE /apps/<app>/packages/<pkg>/tokens/<id>` | admin 或 app token | 吊销 |
| `PUT /apps/<app>/hosts/<hostVersion>`（快照字节） | admin 或 app token | 宿主 CI 上传该宿主版本提供了什么；只写一次，不同字节 → 409 |
| `GET /apps/<app>/hosts/<hostVersion>` | 本 app 的任一 token | 读回；`tinyui bundle` 签名前据此核对包 |

这些都碰不到客户端的信任链：设备只认 App 内置的公钥。

## 私有化部署

Cloudflare Workers + 一个 R2 桶（付费版最低档即可）。包内容与元数据都放 R2：它是强一致的，token 吊销即时生效，指针发布即时可见。

1. fork 或 clone。建一个 R2 桶，名字填进 `wrangler.toml`。
2. `npx wrangler secret put ADMIN_TOKEN`
3. `pnpm install && pnpm deploy`；也可在 Cloudflare 后台连上仓库，push 即部署。
4. 对自己的实例跑 `tinyui apps create …`、`tinyui packages create …`、`tinyui tokens create …`，然后把各 App 的 `fetch` base 指向 `https://<host>/<app>/<channel>`。

托管实例（自定义域名 `updates.tinyui.app`）由 Cloudflare Workers Builds 在每次 push 到 `main` 时自动部署，执行 `wrangler deploy --config wrangler.tinyui.toml`；`wrangler.toml` 保持通用模板。

本地运行：`pnpm dev`（`.dev.vars` 放 `ADMIN_TOKEN`，见 `.dev.vars.example`）。测试：`pnpm test`（Workers 运行时，R2 由 miniflare 模拟）。

存储收在 `src/storage.ts` 的 `Storage` 接口后：Cloudflare 用 `R2Storage`，测试与其他运行时用 `MemoryStorage`。

## License

[MIT](./LICENSE)
