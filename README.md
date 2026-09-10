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
| `npm run engine` | 首次安装本地真实引擎（Node 24 + GCC 15，约数分钟） | 否 |
| `npm run sim [-- --ticks N]` | **本地真实引擎**跑产物：真实寻路/疲劳/能量流，断言**结果** | 否 |
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

## 三层验证（各管一段，不可互相替代）

| 层 | 验证什么 | 管不到什么 |
|---|---|---|
| `npm test`（204 项） | 纯决策逻辑、租约、状态阈值、身体成本 | **物理**：无引擎 |
| `npm run smoke` | 产物可加载、CPU 降级、段写入、`loop` 导出 | `moveTo` 被桩掉，无寻路 |
| `npm run sim` | **真实引擎**：寻路、疲劳、能量流、建造、吞吐 | 需先装引擎 |

**为什么三层都要**：本期线上踩到的 bug **全部是物理层失败**（寻路被静止 creep 堵死、缓存路径穿过被占格、spawn 被自家工地围死、3 tick/格身体），
对前两层结构性不可见。而 `sim` 断言的是**结果而非意图** —— 意图一直是对的。

### 本地引擎为何需要特定工具链

| 组合 | 结果 |
|---|---|
| Node 26 + GCC 16 | 失败：V8 13.6 改了 `GetAlignedPointerFromInternalField`；Nan 模块编不过 |
| Node 24 + GCC 16 | 失败：isolated-vm 自身 timer 模板错配 |
| **Node 24 + GCC 15** | **成功** |

引擎装在 `.engine/`（独立 Node 24 与 GCC 15），项目本身仍在 Node 26。

### 部署门禁

`npm run deploy` 会**先跑 `npm run sim`**，通过才上传（`SKIP_SIM=1` 可覆盖）。
动机是实测代价：一次部署消耗 240/天 配额中的 1 次，再以 4 秒/tick 观察数分钟，
才能发现本地 245 ms/tick 就能复现的 bug。

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

**M0 / M1 / M2 已完成；M3 进行中（RCL 2 已达）。AI 正在线上自主运行。**

- **M0**：五道门禁全绿，token 连通，shard 自动识别，端到端部署已验证。
- **M1**：内核骨架（tick 管线 / CPU 降级 / heap / cache / Memory 迁移与 GC / 日志节流 / 错误隔离 / profiler / stats 段）。
- **M2**：任务租约、角色行为、RCL 状态机、spawn 管理。**线上闭环已实测**。
- **M3（进行中）**：RCL **1→2 已完成**；extension 建造规划已上线并在建。

177 单测 + 真实房间回放 + 15 项 smoke 断言。

### 线上实测（RCL 2，t≈82878430）

| 指标 | 实测 |
|---|---|
| RCL 进度 | 约 1 /tick |
| 建造进度 | 约 4 /tick |
| extension | **3000 能量/个**（5 个 = 15,000） |
| RCL 2→3 | 45,000 能量 |
| tick 速率 | 约 4 秒/tick |

**当前瓶颈是收入，不是容量**：建造按 1:1 消耗能量，builder 以 4/tick 吃掉全部收入（总收入 1–2/tick），因此建造期间控制器进度停滞。这是资源竞争的正常表现。

**随时间自愈的一项**：线上仍有 4 个 creep 是移动比率修复**之前**出生的（2–3 tick/格）；修复后的比率为 1 tick/格。它们随 1500 tick 寿命自然淘汰。

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
