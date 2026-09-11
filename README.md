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
| `npm run smoke` | 跑**真实产物** 200 tick × 2 相（常规 + CPU 高压），验证加载/导出/不抛异常 | 否 |
| `npm run whoami` | 账号身份 + shard 自动识别 + CPU 上限 | 1 次请求 |
| `npm run deploy [-- --dry-run]` | 上传 `dist/main.js` 到分支 | `POST /api/user/code` |
| `npm run watch [-- --seconds N]` | WebSocket 流式订阅 console | **否**（不占 HTTP 配额） |
| `npm run stats` | 拉取 memory segment 统计，追加 `docs/live-metrics.md` | `GET /api/user/memory-segment` |
| `npm run snapshot` | 录制线上房间快照为测试夹具（轨道 B 的输入） | 2 次请求 |
| `npm run engine` | 首次安装本地真实引擎（Node 24 + GCC 15，数分钟）——**工具，无夹具消费者** | 否 |

## 配额是硬约束

用 token 认证的请求全部限流（浏览器/Steam 客户端不限流）：

| 端点 | 配额 |
|---|---|
| 全局 | 120 / 分钟 |
| `POST /api/user/code`（部署） | **240 / 天** |
| `GET /api/user/memory` | 1440 / 天 |
| `GET /api/user/memory-segment` | **360 / 小时**（比 Memory 宽 6 倍） |

两个直接后果：**部署本身是稀缺资源**（`deploy.mjs` 自限 60/天，留余量应对线上故障），**统计走 segment 而非 Memory**。日常观测优先用 `watch`（WebSocket 不占配额）。

## 验证层

| 层 | 验证什么 | 管不到什么 |
|---|---|---|
| `npm test`（vitest） | 纯决策逻辑 | 物理；无引擎 |
| `npm run smoke` | 产物可加载、导出 `loop`、两种 CPU 预算下 200 tick 不抛异常 | 游戏行为、寻路、能量流 |
| `npm run snapshot` | 录制线上房间快照为夹具 | 不验证任何东西，只取数据 |
| 本地引擎（`npm run engine`） | **能力保留**：真实物理逐 tick 可测（238 ms/tick vs 线上 4000 ms/tick） | v1 的夹具已删，新夹具待重设计 |

## 架构不变式

> **纯逻辑层（`src/domain/**`）永不 import 引擎全局，也不 import 引擎感知层。**

由 `eslint.config.mjs` 硬性拦截：`Game`/`Memory`/`RawMemory`/`PathFinder`/`InterShardMemory` 在任意 `.ts` 中都是受限全局，`src/main.ts` 与 `scripts/**` 例外（唯一允许触碰引擎之处）。该守卫在重写后依然生效。

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

> **2026-09-11：实现层已清空，等待重新设计。**
>
> `src/domain`、`src/game`、`src/kernel`、`src/colony`、`test/` 与 v1 的本地引擎测试夹具（`scripts/local-sim.mjs`、`sim.sh`、`lib/fake-room.mjs`）已删除；
> **引擎本身的能力保留**：`scripts/engine-setup.sh`（`npm run engine`）仍可装出本地真实引擎——Node 24 + GCC 15，约 238 ms/tick，对比线上约 4000 ms/tick。
> `src/main.ts` 是空的 `loop()` 占位，保证 build/typecheck/lint/smoke 仍可运行。
> 下面保留的是**实测事实**（对重新设计仍然有效），不是对现有代码的描述。

### 线上实测基线（shard3，`W34S1`）

| 指标 | 实测 |
|---|---|
| tick 速率 | **约 4 秒/tick**（60 秒约 15 tick） |
| 房间几何 | controller (43,17) / spawn (24,10) / source (24,5) 与 (5,38) |
| RCL 1→2 | 200 能量；RCL 2→3 需 45,000 |
| extension 单价 | **3000 能量/个**（实测） |
| 容器 | 5000 hits / 500 tick（owned，10 hits/tick）→ 满血约 28 小时 |
| CPU | `cpuLimit: 20` = 未解锁 |
| 账号 | 在 `shard3`；`userOverview()` 不可用，判据见 `scripts/lib/shard.mjs` |

几条由实测确立、跨实现仍然成立的结构性规则：

1. **装满再移动。** 角色原本「一有能量就出发」，harvester 采 4 能量走 5 格 —— 控制器进度长期为 0。修复后吞吐提升约 10 倍。
2. **唯一的恢复手段必须有主动保留。** 只有 harvester 会向 spawn 存能量；spawn 能量是殖民地唯一能重建收入的手段，见底即不可自愈。
3. **用不变量检查取代几何规则。** 「保留 spawn 的 N 邻格」不足（8 方向移动，半径 2 处封格同样堵死走廊）；放置前对房间做一次 BFS 才是直接回答。
4. **占满配额的东西必须能被回收**，否则修复会静默自锁（工地计入结构上限时的经典陷阱）。
5. **角色/结构的行为必须在真实引擎里验证。** 逐 tick 断言「结果而非意图」：意图层一直是对的，物理层才是 bug 来源。

### `npm run smoke` 能证明什么、不能证明什么

跑的是**真实上传产物** `dist/main.js`（不是 TS 源码），对着按文档契约建模的引擎全局跑 N tick。因此：

- **能证明**：产物可加载、导出可调用的 `loop`、在常规与高压两种 CPU 预算下重复调用都不抛异常。
- **不能证明**游戏行为 —— 这里没有物理。判断「脚本做得对不对」需要另外的验证层，由新设计定义。

> 注意 harness 的一个刻意设计：CPU 在 `loop()` **之前**计入。若在之后计入，`getUsed()` 恒为 0，任何预算逻辑都跑不到。
