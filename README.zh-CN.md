# tinyui-updates-server

[English](./README.md) | 简体中文

[TinyUI](https://github.com/tiny-ui/tinyui) 包的热下发投递与发布服务：TinyUI 仓 `docs/updates.md` 协议的参考实现，跑在 Cloudflare Workers 上。托管实例是 `updates.tinyui.app`；私有化就是把同一份代码部署到自己的 Cloudflare 账号。

服务只是搬运工，不是信任锚。包由发布方签名（`tinyui bundle --signing-key`），服务端在发布时用该包登记的公钥验签，客户端再用 App 内置的公钥验一次。发布 token 泄露发不出客户端认的包，服务端被攻破也发不出。

## 投递什么

两类 `GET`，相对 `https://<host>/<app>/<channel>`：

| 路径 | 内容 | 缓存 |
|---|---|---|
| `<pkg>/<rv>/current.json` | 可变指针：`{ version, rollout, signature }` | `no-store` |
| `<pkg>/<rv>/<version>/…` | 不可变内容：`manifest.json`、`runtime/*.bin`、`pages/**/*.bin` | `immutable` |

内容按 `(app, pkg, rv, version)` 存一份；channel 只是指针，staging 验过的版本晋级到 production 只动指针，不重传。

## 发布

所有请求带 `Authorization: Bearer <token>`。

| 请求 | 语义 |
|---|---|
| `PUT /<app>/<pkg>/<rv>/<version>/<path>` | 上传一个文件（幂等；同路径不同内容 → 409） |
| `PUT /<app>/<channel>/<pkg>/<rv>/current.json`，body `{ version, signature, rollout? }` | 发布：用登记的公钥对已上传的 `manifest.json` 原始字节验签，核对 `name` / `runtimeVersion` / `version` / `publicKey` 与每个文件的 sha256，记录 release，切指针 |
| `GET /<app>/<pkg>/<rv>/releases` | 已发布的版本与各 channel 的指针 |
| `POST /<app>/<channel>/<pkg>/<rv>/pointer`，body `{ version?, rollout? }` | 回滚、晋级、改灰度是同一个操作 |

`tinyui-cli` 的 `tinyui publish` / `tinyui releases …` 是这些端点的薄封装。

## 管理（`ADMIN_TOKEN`）

| 请求 | 语义 |
|---|---|
| `POST /apps` `{ id, name, org? }` | 建 app（`id` 是路径段；`org` 只用于计费归属） |
| `POST /apps/<app>/packages` `{ name, publicKey }` | 登记包与其验签公钥 |
| `PUT /apps/<app>/packages/<pkg>/publicKey` | 轮换公钥 |
| `POST /apps/<app>/packages/<pkg>/tokens` `{ channels }` | 签发限定 channel 的发布 token；只返回一次，服务端只存哈希 |
| `DELETE /apps/<app>/packages/<pkg>/tokens/<id>` | 吊销 |

## 私有化部署

Cloudflare Workers + 一个 R2 桶（付费版最低档即可）。包内容与元数据都放 R2：它是强一致的，token 吊销即时生效，指针发布即时可见。

1. fork 或 clone。建一个 R2 桶，名字填进 `wrangler.toml`。
2. `npx wrangler secret put ADMIN_TOKEN`
3. `pnpm install && pnpm deploy`；也可在 Cloudflare 后台连上仓库，push 即部署。
4. 对自己的实例跑 `tinyui apps create …`、`tinyui packages create …`、`tinyui tokens create …`，然后把各 App 的 `fetch` base 指向 `https://<host>/<app>/<channel>`。

本地运行：`pnpm dev`（`.dev.vars` 放 `ADMIN_TOKEN`，见 `.dev.vars.example`）。测试：`pnpm test`（Workers 运行时，R2 由 miniflare 模拟）。

存储收在 `src/storage.ts` 的 `Storage` 接口后：Cloudflare 用 `R2Storage`，测试与其他运行时用 `MemoryStorage`。

## License

[MIT](./LICENSE)
