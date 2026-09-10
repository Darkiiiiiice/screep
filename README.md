# screep

Screeps: World MMO AI — 纯官方线上（screeps.com）方案。

实施计划见 [`PLAN.md`](./PLAN.md)。

## 快速开始

```bash
npm install
npm install-scripts approve esbuild   # npm 12 默认拦截 install script，需放行 esbuild 二进制

cp .env.example .env                  # 填入 screeps.com 的 auth token
npm run whoami                        # 验证 token；自动识别所在 shard
```

## 命令

| 命令 | 作用 | 消耗线上配额 |
|---|---|---|
| `npm run build` | esbuild 打包 → `dist/main.js`（单文件 CJS，导出 `loop`） | 否 |
| `npm run typecheck` | `tsc --noEmit` 类型门禁（esbuild 只剥类型不检查） | 否 |
| `npm run lint` | eslint，含**架构守卫**（见下） | 否 |
| `npm test` | vitest 单测（纯逻辑，毫秒级） | 否 |
| `npm run whoami` | 账号身份 + shard 自动识别 + CPU 上限 | 1 次请求 |
| `npm run deploy [-- --dry-run]` | 上传 `dist/main.js` 到分支 | `POST /api/user/code` |
| `npm run watch [-- --seconds N]` | WebSocket 流式订阅 console | **否**（不占 HTTP 配额） |
| `npm run stats` | 拉取 memory segment 统计，追加 `docs/live-metrics.md` | `GET /api/user/memory-segment` |

## 配额是硬约束

用 token 认证的请求全部限流（浏览器/Steam 客户端不限流）：

| 端点 | 配额 |
|---|---|
| 全局 | 120 / 分钟 |
| `POST /api/user/code`（部署） | **240 / 天** |
| `GET /api/user/memory` | 1440 / 天 |
| `GET /api/user/memory-segment` | **360 / 小时**（比 Memory 宽 6 倍） |

两个直接后果：**部署本身是稀缺资源**（`deploy.mjs` 自限 60/天，留余量应对线上故障），**统计走 segment 而非 Memory**。日常观测优先用 `watch`（WebSocket 不占配额）。

## 架构不变式

> **`src/domain/**` 永不 import 引擎全局，也不 import 引擎感知层（`game/`、`kernel/`、`colony/`）。**

没有本地引擎测试环境，这条是唯一的安全网：绕过它，任何改动都只能靠线上真实世界试错，每次消耗部署配额并可能赔掉 creep。由 `eslint.config.mjs` 硬性拦截，并有反例测试确认规则会触发。

分层：

| 目录 | 性质 |
|---|---|
| `src/domain/**` | **纯逻辑**，可单测，禁 I/O 与引擎访问 |
| `src/kernel/**` | 引擎感知的基础设施（tick 管线、CPU 预算、缓存、日志） |
| `src/game/**` | 引擎适配层，唯一触碰 `Game`/`Room`/`Creep` 之处 |
| `src/colony/**` | 组合层，把 domain 决策接到适配层 |

## 工具链说明（踩过的坑）

- **TypeScript pin 在 `~6.0.3`**：`typescript-eslint@8.70.0` 的 peer 是 TS `>=4.8.4 <6.1.0`，且尚无 v9；TS latest 是 7.0.2。esbuild 负责转译，tsc 只做类型检查，故不值得为 TS 7 承担 lint 生态缺失的风险。
- **`dist/package.json` 声明 `{"type":"commonjs"}`**：本项目是 `"type": "module"`，若不加这层声明，Node 会把 `dist/main.js` 当 ESM 解析，`module.exports` 被忽略、产物看起来什么都没导出。
- **构建产物校验方式是「真实加载后断言 `typeof loop === 'function'`」**，不是正则匹配压缩后的文本。
- **shard 永不假设为 `shard0`**：本账号在 `shard3`。判据见 `scripts/lib/shard.mjs`（`gameShardsInfo()` 的 `cpuLimit > 0` 为主，`userWorldStartRoom()` 非空为交叉验证）。`userOverview()` **不可用** —— 它对未开局的账号也列出全部 shard。

## 当前状态

- M0 已完成：四道门禁全绿，token 连通，shard 自动识别，端到端部署已验证。
- **世界状态为 `empty`** —— 尚未放置首个 spawn，需要在 shard3 的候选房间中选定一个开局，M2 起的验收才可进行。
