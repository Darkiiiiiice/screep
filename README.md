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
| `npm run smoke` | 跑**真实产物** 200 tick × 2 相（常规 + CPU 高压），验证加载/导出/降级/段写入 | 否 |
| `npm run whoami` | 账号身份 + shard 自动识别 + CPU 上限 | 1 次请求 |
| `npm run deploy [-- --dry-run]` | 上传 `dist/main.js` 到分支 | `POST /api/user/code` |
| `npm run watch [-- --seconds N]` | WebSocket 流式订阅 console | **否**（不占 HTTP 配额） |
| `npm run stats` | 拉取 memory segment 统计，追加 `docs/live-metrics.md` | `GET /api/user/memory-segment` |
| `npm run snapshot` | 录制线上房间快照为测试夹具（轨道 B 的输入） | 2 次请求 |

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

**M0 / M1 / M2 已完成，AI 正在线上运行。**

- **M0**：五道门禁全绿，token 连通，shard 自动识别，端到端部署已验证。
- **M1**：内核骨架（tick 管线 / CPU 降级 / heap / cache / Memory 迁移与 GC / 日志节流 / 错误隔离 / profiler / stats 段）。
- **M2**：任务租约、角色行为、RCL 状态机、spawn 管理。**线上闭环已实测**：harvester 采满 → 交付 spawn → upgrader 出生 → 控制器进度增长。

143 单测 + 真实房间回放 + 15 项 smoke 断言。

### 线上实测基线（shard3）

| 指标 | 实测 |
|---|---|
| tick 速率 | **约 4 秒/tick** |
| 房间 | `W34S1`（controller 43,17 / spawn 24,10 / 2 sources） |
| 移速 | 约 2 tick/格 |

两个由实测发现并修复的问题值得记住：

1. **装满再移动**。角色原本「一有能量就出发」，harvester 采 4 能量走 5 格 —— 控制器进度长期为 0。修复后吞吐提升约 10 倍。
2. **BOOTSTRAP 只留一个 harvester**。「每 source 一个」会让殖民地在造出 upgrader 前先造第二个 harvester；而 RCL 1→2 只要 200 能量却解锁 +250 容量，是前期回报最高的单步。

### `npm run smoke` 能证明什么、不能证明什么

跑的是**真实上传产物** `dist/main.js`（不是 TS 源码），对着按文档契约建模的引擎全局跑 N tick。因此：

- **能证明**：产物可加载、导出 `loop`、重复调用不崩溃、Memory 迁移只发生一次、stats 段写入且有界、CPU 降级按优先级生效且**关键阶段（spawn/assign/cleanup）从不被跳过**。
- **不能证明移动/伤害/资源消耗/结构耐久** —— 这些只在真实引擎里存在。因此 M1–M3 的策略必须保守。

> 注意 harness 的一个刻意设计：CPU 在 `loop()` **之前**计入。若在之后计入，内核看到的 `getUsed()` 恒为 0，降级路径永远不会被跑到。
