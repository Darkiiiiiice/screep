# Screeps: World AI —— 实施计划

> 目标：从零构建一套可持续演进、可回归验证的 Screeps MMO（screeps.com）AI 脚本。
> 决策基线（已确认）：**只在官方线上玩，不做私服**；TypeScript + esbuild 精简流水线；纯逻辑单测为核心验证手段；首个里程碑是内核框架（调度/任务/状态机）；已有账号与 token。

---

## 1. 事实基线

### 1.1 运行环境

| 事实 | 值 | 来源 |
|---|---|---|
| 官方引擎版本 | `@screeps/engine@4.3.2` | screeps/engine `package.json` |
| **官方线上运行时** | **Node.js v24**（Screeps: World 已升级） | screeps-api v2 迁移指南 |
| 默认 CPU | 20 ms/tick（未解锁）；解锁后每 GCL +10，上限 300 | docs/cpu-limit、docs/control |
| bucket | 上限 10,000；单 tick 最多透支 500 | docs/cpu-limit |
| Memory 上限 | 2 MB，跨 tick 走 `JSON.parse/stringify` | docs/global-objects |
| 模块系统 | `require` / `module.exports`（CJS 风格），另支持二进制模块（WebAssembly） | docs/modules |
| 类型定义 | `@types/screeps@3.4.0`（2026-04 更新） | npm registry |
| 部署/观测工具 | `screeps-api@2.1.0` —— **仅 ESM**，接口已改名扁平化 | screeps-api v2 迁移指南 |
| 官方路线图（2026） | 恢复 3 个月赛季重置；补 Power Creeps（Commander/Executor）；新分片（约 1s tick）；运行时升级，含**原生 ESM 与文件夹模块支持**、官方 VSCode 扩展 | 官方 2026 roadmap |

**推论**：源码按 ESM 写、构建期打包成单文件（`module.exports.loop`）上传；待官方 ESM 落地，去掉打包步骤改整目录上传即可，源码零改动。构建 target 定 `node24`。

### 1.1.1 本账号实测结论（P0 已验证，非推测）

| 项 | 实测值 | 判定依据 |
|---|---|---|
| 账号 | `darkiiiiiice`，user id `67a322b77214860012912bcb` | `authMe()` |
| **所在 shard** | **`shard3`** | `gameShardsInfo()` 中仅 shard3 报 `cpuLimit: 20`；且 `userWorldStartRoom('shard3')` 返回候选出生房 `W55S5, W15N45, W35S5` |
| **CPU 是否解锁** | **未解锁**（`cpuLimit: 20`） | 同上限流表：未解锁固定 20。**这直接决定 §8 的结论** |
| 世界状态 | `empty` —— **尚未放置出生点（spawn）** | `userWorldStatus()` → `{"ok":1,"status":"empty"}`，`userOverview().shards[shard3].rooms = []` |

**两个必须前置的现实约束**：

1. **世界是 `empty`** —— 没有 spawn 就没有 creep，AI 部署上去也无事可做。**M2/M3 的验收被此阻塞**：需要你先在 shard3 的三个候选房间（`W55S5` / `W15N45` / `W35S5`）中选定一个并放置首个 spawn。在此之前 M0/M1 可以推进（空内核不依赖房间），但 M2 起必须等开局。
2. **CPU 20 已确认** —— 见 §8。

### 1.1.2 shard 自动识别（已实现并验证）

**永远不要假设 `shard0`。** 本账号被分配到 shard3，且赛季/新手分片会漂移。两路**独立**服务端信号互相印证：

| 信号 | 判据 | 成本 |
|---|---|---|
| `gameShardsInfo()` ← **主判据** | 账号所在 shard 报真实上限（`cpuLimit: 20`），不在的 shard 报 `cpuLimit: 0` | 1 次请求 |
| `userWorldStartRoom(shard)` ← 交叉验证 | 只有被分配的 shard 返回候选出生房（非空数组），其余返回 `[]` | 每 shard 1 次 |

**不可用的信号**：`userOverview()`。它对从未开局的账号也列出**全部** shard 且 `rooms: []`，无法区分"已分配"与"未分配"—— 这是实测推翻的一个直觉假设。

实现见 `scripts/lib/shard.mjs`；`SCREEPS_SHARD` 显式设置时优先，但与检测结果不符会**告警而非静默遵从**（.env 里的过期值正是要防的故障）。

### 1.2 部署配额与速率限制（**本计划最重要的约束**）

`docs/auth-tokens.md`：浏览器/Steam 客户端的常规请求**不限流**，但**用 token 认证的所有请求都限流**，超限返回 `429`。响应头带 `X-RateLimit-Limit/Remaining/Reset`。

| 端点 | 配额 | 折算 |
|---|---|---|
| **全局** | **120 / 分钟** | 2 / 秒 |
| `POST /api/user/code` | **240 / 天** | **平均 6 分钟一次部署** |
| `POST /api/user/set-active-branch` | 240 / 天 | 切换激活分支 |
| `GET /api/user/code` | 60 / 小时 | |
| `GET /api/user/memory` | 1440 / 天 | 1 / 分钟 |
| `POST /api/user/memory` | 240 / 天 | |
| `GET /api/user/memory-segment` | **360 / 小时** | **6 / 分钟 —— 比 Memory 宽 6 倍** |
| `POST /api/user/memory-segment` | 60 / 小时 | |
| `POST /api/user/console` | 360 / 小时 | |
| `GET /api/game/room-terrain` | 360 / 小时 | |
| `POST /api/game/map-stats` | 60 / 小时 | |

**三条直接设计结论**：

1. **部署 = 消耗预算**。240/天意味着一整个下午的高频迭代就能烧完。→ 每次部署前必须离线验证过关；禁止"改一行推一次"。
2. **可观测性要选便宜的信道**。统计写进 **memory segment**（6/分钟）而不是 `Memory`（1/分钟）—— 同样的信息量，带宽宽 6 倍。
3. **逃生舱**：token 可经浏览器点击（reCAPTCHA 保护，无法自动化）获得 **2 小时免限流窗口**（`/a/#!/account/auth-tokens/noratelimit?token=XXX`）；也可用 `GET /api/auth/query-token` 查询该窗口状态。重迭代时段用这个。

### 1.3 分支与环境语义（决定部署策略）

官方 2015 分支公告原话：*"The branch being edited at the moment is the one active in the game. However, **the World may have one active branch, the Simulation another one**."* 官方限流表中存在 `POST /api/user/set-active-branch`（240/天）佐证该机制仍在。

**推论**：

- **世界（World）同一时刻只有一个分支在跑** —— 官方线上**没有 staging 环境**，不存在"dev 和 main 同时跑、A/B 对比"。所谓 dev 分支策略实际是"激活 dev → 观察 → 激活回 main"。
- **Simulation 模式有独立的分支**，与 World 互不干扰 → 这是线上玩家**唯一的本地安全试验场**（在官方客户端内，浏览器里跑真实引擎）。
- 客户端 Simulation 是人工交互的，无法在 Node 侧自动化。

### 1.4 关于私服（已排除，仅记录原因）

`screeps-server-mockup@1.5.1`（逐 tick 推进真实引擎的测试夹具）在本机**编译失败**，两轮实测：

- Node 26.8.2 / GCC 16.2.1：`v8::Object::GetAlignedPointerFromInternalField(int)` 参数不匹配 —— Node 26 的 V8 新增了 `EmbedderDataTypeTag` 参数，`isolated-vm@6.1.2`（driver 钉的 2026-03-16 commit）早于这次 V8 API 断裂。
- Node 24.21.0：`isolated-vm` 自身 C++ 模板匹配错误（`timer.h:25` 的 `wait_detached`），与 Node 版本无关。

且 `@screeps/driver` 直接 `require('isolated-vm')`，无法绕开。**结合"不做私服"的决定，此路线彻底移除**——代价是失去本地真实引擎验证，补偿方案见 §4。

---

## 2. 技术选型与目录结构

```
screep/
├── PLAN.md
├── package.json          # "type": "module"（screeps-api v2 仅 ESM）
├── tsconfig.json  eslint.config.js
├── scripts/
│   ├── build.mjs         # esbuild → dist/main.js（单文件，target node24）
│   ├── deploy.mjs        # 推送 + 激活分支 + 配额记账
│   ├── watch.mjs         # WebSocket 订阅 console，实时流式输出
│   └── stats.mjs         # 拉取 memory segment 统计，落 docs/live-metrics.md
├── src/
│   ├── main.ts           # 入口：global 复用 + tick 生命周期
│   ├── kernel/           # 与游戏内容无关的调度/预算/缓存
│   │   ├── tick.ts       # 阶段调度 + CPU 预算 + 降级
│   │   ├── cache.ts      # tick 级对象缓存
│   │   ├── heap.ts       # global 持久层（跨 tick、不进 Memory）
│   │   ├── memory.ts     # schema 版本 + 迁移 + GC
│   │   ├── stats.ts      # 统计写入 memory segment（避开限流瓶颈）
│   │   ├── log.ts        # 结构化日志 + 限流
│   │   ├── errors.ts     # 错误隔离 / 去重 / 上报
│   │   ├── profiler.ts   # 分阶段 CPU 统计
│   │   └── settings.ts   # 全部可调参数集中处
│   ├── game/             # 引擎适配层：唯一允许触碰 Game/Room/Creep 的地方
│   ├── domain/           # 纯逻辑：禁止 import game/，全部可单测
│   │   ├── tasks/        # 任务定义 / 注册表 / 生命周期
│   │   ├── roles/        # 行为策略
│   │   ├── plans/        # 殖民计划：需求计算、配比、body 设计
│   │   └── economy/      # 能量流与物流配额
│   └── colony/           # 组合层：把 domain 决策落到 game 适配层执行
├── test/
│   ├── unit/             # 轨道 A：纯逻辑单测（vitest）
│   ├── fixtures/         # 自建 Game stub + 从线上录制的真实快照
│   └── replay/           # 轨道 B：录制回放，断言命令序列
└── dist/                 # 构建产物（不入库）
```

### 不可动摇的架构不变式

> **`domain/` 永不 import `game/`；`game/` 是唯一 import 引擎全局的层。**

去掉私服后，这条不变式的权重**从"提高可测性"上升到"唯一的安全网"**：官方线上没有 staging，任何绕开适配层的代码都只能靠线上真实世界试错，而每次部署要花掉 240/天 里的 1 次，且可能赔掉 creep。适配层薄、domain 纯，是让离线验证有意义的前提。

### 版本选择

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript | `@types/screeps@3.4.0` 提供完整 API 类型；AI 到几千行后 API 误用是主要 bug 源 |
| 模块 | ESM（`"type": "module"`） | `screeps-api@2` 仅 ESM；ESM 也是官方运行时演进方向 |
| 打包 | esbuild 0.28 → 单文件，`target: node24` | 零配置、毫秒级增量；target 对齐官方运行时，避免产出 Node 24 不认的语法 |
| 类型检查 | `tsc --noEmit` 独立于打包 | esbuild 只剥类型不检查，类型门禁必须独立一步 |
| 单测 | vitest 5 | 原生 TS/ESM、watch 快 |
| 线上交互 | screeps-api 2.1.0 | `ScreepsHttpClient` + `ScreepsSocketClient` |
| 不引入 | 任何社区 AI 框架（Overmind 等） | 黑盒内核会挡住 M1 目标；仅借鉴其 CPU 预算与缓存分层思路 |

---

## 3. 内核设计（M1 交付内容）

### 3.1 tick 管线

```mermaid
flowchart LR
  A[prefetch<br/>采集 Game 快照] --> B[intel<br/>情报更新]
  B --> C[plan<br/>殖民计划/需求]
  C --> D[spawn<br/>补员与 body 设计]
  D --> E[assign<br/>任务申请/租约]
  E --> F[execute<br/>creep 行为]
  F --> G[cleanup<br/>GC + 统计写 segment]
```

- 每阶段记录 `Game.cpu.getUsed()` 差值，进 `profiler`，按间隔汇总。
- **降级**：`Game.cpu.getUsed() > tickBudget × 0.8` 时按优先级表跳过低优先级阶段，保执行与补员。
- **预算**：`tickBudget` 取 `Game.cpu.tickLimit` 与 `limit + 允许借用` 的较小值，预留约 12% 给 cleanup；bucket 低于阈值时禁止昂贵重算（PathFinder、远矿扫描）。

### 3.2 内核服务

| 服务 | 职责 | 关键约束 |
|---|---|---|
| `cache` | tick 级 `getObjectById` Map 缓存、room 快照；跨 tick 只缓存静态数据（地形、CostMatrix）并按 `Game.time % N` 失效 | 不缓存可变对象引用跨 tick |
| `heap` | `global` 里的跨 tick 状态，以 id 为键 | 引擎重启会清空，任何 heap 数据必须可从 `Game`/`Memory` 重建 |
| `memory` | schema 版本 + 顺序迁移 + 死亡 creep 惰性 GC | 迁移必须幂等；每 tick 只 GC 一部分 |
| `stats` | **统计写入 memory segment，不走 `Memory`** | 见 §3.5：segment 的读取配额是 `Memory` 的 6 倍 |
| `log` | `log(scope, level, msg, data)`，同类消息限流 | console 有 CPU 成本且过量会被截断 |
| `errors` | 按「签名 + 位置」去重，仅首次/每 N tick 输出；栈压进 `Memory` 环形缓冲（最近 50 条） | 单点异常绝不能中断整 tick |
| `profiler` | 分阶段 CPU + creep 数 + 内存大小，按递增间隔汇总 | 汇总本身有成本 |

### 3.3 Memory 策略（从 M1 就锁死）

**`Memory` 只存**：schema 版本、错误环形缓冲、参数覆盖、情报摘要。

**不存 `Memory` 的三类，以及各自去哪：**

| 数据 | 存放 | 理由 |
|---|---|---|
| per-creep 个体状态 | `global` heap（按 id 索引） | 2 MB 上限 + 每 tick 全量 `JSON.stringify`；creep 数量增长时这是最先崩的地方 |
| 任务板（含租约） | `global` heap | **见下** |
| 大地图 / 情报 / 统计 | `RawMemory` segment | 不进 2 MB 预算，且读取配额是 `Memory` 的 6 倍（§1.2） |

**任务板为什么在 heap 而不是 Memory** —— 这条值得写下来，因为直觉上会选 Memory：

> 任务板**不是累积状态，而是对派生工作的预约**。`planTasks` 每 tick 从房间快照**重建**整个任务集合并剪掉不再需要的（§3.4 的派生性质）；租约只是「这活儿归谁」的标记，脱离它所预约的工作就没有意义。既然工作每 tick 重建，预约也可以。

具体权衡：

- 放 Memory 的代价是**每 tick 一次随任务数增长的 `JSON.stringify`**，收益是租约能活过部署。
- 但活过部署几乎不值钱：部署后 creep 仍在按旧代码行动，下一 tick 板子从同一个房间重建出同一批任务，creep 重新租到同样的活。最坏情况是「一个 creep 从送往容器 X 改成送往容器 Y」。
- 放 heap 的唯一真实损失是租约**截止时间**被重置 —— 而截止时间的作用恰恰是抓「不再请求工作的 creep」，它在 `DEFAULT_LEASE_TICKS`（50 tick）内就会重新判定。重启只是让这个计时器归零。

**租约续期语义（M2 修正的一个真实 bug）**：creep **每次请求工作时续期**。原实现里 `leaseTask` 对已持有租约的 creep 直接返回而**不续期**，于是连续工作 50 tick 后租约必然过期 —— 只因下一 tick 又重新租到同一任务才没出事。这既是徒劳的抖动，也意味着有两间房时，正在进行的工作可能被抢走。

- 禁止 per-creep 状态进 `Memory`（`Memory.creeps.*` 只留角色与最小标记）。

### 3.4 殖民地状态机（按 RCL 键控）

角色不是静态列表 —— 同一批角色在 RCL1 和 RCL6 该干的事完全不同。房间行为由其 RCL 导出的状态决定：

| 状态 | RCL | 结构前提 | 角色配比（示意） | 主要矛盾 |
|---|---|---|---|---|
| `BOOTSTRAP` | 1–2 | 无容器 / 刚出容器 | harvester 自采自送；1 个 upgrader | 能量总量不足，多余角色会饿死 |
| `ESTABLISHED` | 3–5 | 容器、extensions | harvester 定点 + hauler 转运 + upgrader + builder | 物流效率；补员节奏 |
| `MATURE` | 6–7 | storage、terminal、link | link 链路、专用 miner、物流分层 | CPU 预算与房间数同时上升 |
| `EXPANSION` | 8 | 全量 | MATURE 基础上分出殖民/远程队 | 跨房调度与 CPU 分配 |

阈值取自官方 RCL 结构表（`docs/control.html`）：

| RCL | 升到下一级所需能量 | 该级解锁的关键结构 |
|---|---|---|
| 0 | — | 中立/未占领（仅 roads、5 containers） |
| 1 | **200** | **1 Spawn** |
| 2 | **45,000** | 5 Extensions（50 容量） |
| 3 | 135,000 | 10 Extensions、**1 Tower** |
| 4 | 405,000 | 20 Extensions、**Storage** |
| 5 | 1,215,000 | 30 Extensions、**2 Links** |
| 6 | 3,645,000 | 40 Extensions、3 Links、**Extractor、3 Labs、Terminal** |
| 7 | 10,935,000 | 50 Extensions（100 容量）、**2nd Spawn**、4 Links、Factory |
| 8 | — | 60 Extensions（200 容量）、3 Spawns、**Observer、Power Spawn、Nuker** |

关键含义：

- RCL **1→2 只需 200 能量**，而 **2→3 要 45,000**（225 倍）—— 前中期最陡的性价比断崖。`BOOTSTRAP`→`ESTABLISHED` 的迁移判据要围绕"何时能稳定产出 45k 能量"，而非等级数字。
- 容器上限恒为 **5 个**（RCL 0 起即 5，之后不增）→ 容器选址是**一次性决策**，选错没有第二次机会。M3 里当硬约束写进测试。
- `ESTABLISHED` 累计能量目标：RCL 1→5 共 `200 + 45,000 + 135,000 + 405,000 = 585,200`（M3 验收标准的由来）。
- Controller 在 RCL 1 的降级计时 **20,000 tick** → "停更 upgrader"在 RCL 1 就会致命，补员优先级里 upgrader 不能排太低。

- 状态**只由 `room.controller.level` + 实际建成的结构推导**，不存 Memory（可从 `Game` 重建，符合 §3.2 heap 不变式）。
- 每个状态声明自己需要的角色清单与数量；`domain/plans/` 按当前状态算需求。
- 状态迁移**单向且带滞后**，避免在阈值上抖动。

### 3.5 线上可观测性（去掉私服后的**一等交付物**）

没有本地引擎，线上观测就是唯一的真实反馈源；而它受 §1.2 配额约束。因此观测设计必须在 M1 就位，且**默认省钱**：

| 手段 | 信道 | 成本 | 用途 |
|---|---|---|---|
| 脚本 console 输出 | WebSocket 订阅 `console` | **不走 HTTP 配额**（token 需含 websocket 事件权限） | 实时事件流、异常、里程碑 |
| 统计快照 | `RawMemory` segment + `GET /api/user/memory-segment` | **360/小时（6/分钟）** | CPU/creep 数/RCL/内存的趋势曲线 |
| 全量 Memory 转储 | `GET /api/user/memory` | 1440/天（1/分钟） | 低频深挖、故障复盘 |
| 控制台求值 | `POST /api/user/console` | 360/小时 | 手动探查线上状态 |
| 房间地形 | `GET /api/game/room-terrain` | 360/小时 | 情报预计算，结果缓存进 segment |

设计要点：

- **统计走 segment 而非 `Memory`** —— 同一份数据的读取配额宽 6 倍，这是纯粹的白拿。
- `scripts/watch.mjs` 常驻订阅 WebSocket console，滚动输出到终端与日志文件；这是开发时的主观测面。
- `scripts/stats.mjs` 按固定间隔（默认 60s，可调）拉 segment，追加到 `docs/live-metrics.md`，形成可回溯的指标曲线。
- 所有 API 调用经一个薄封装，内置**配额记账**（按 §1.2 表）+ 429 处理基线（全局 429 自动重试默认开；端点 429 默认关，需显式处理）。
- token 建议**按权限拆分**：一个含 websocket 事件的观测 token、一个含 `user/code` 的部署 token —— 缩小泄漏面，也便于分别定位限流来源。

---

## 4. 验证策略（无本地引擎）

私服路线移除后，验证完全由这四层构成。**A 是主力**，C/D 是真实世界校验。

### 轨道 A —— 纯逻辑单测（主力，离线、毫秒级）

- `test/fixtures/` 自建 Game/Room/Creep 打桩构造器，不依赖任何引擎包。
- 只断言**行为契约**：需求计算给出的配额、任务租约的互斥与释放、body 设计与可用能量的对应、优先级抢占顺序、状态迁移判定（含 RCL 阈值边界）、内存迁移幂等性。
- 不写"检查字段被复制/默认值/转发"这类实现断言。

### 轨道 B —— 录制回放（离线的集成级验证）

- 用 `screeps-api` 从线上抓取真实快照（房间对象、Memory、地形、creep 状态），存为 fixture。
- 本地对快照跑**完整 loop**（domain + 适配层），断言**发出的命令序列**（`creep.moveTo` / `spawnCreep` / `transfer` 的调用与参数）。
- 价值：覆盖适配层与 domain 的集成 bug（undefined 访问、id 失效、类型错配），这些是轨道 A 的 stub 天然测不到的；且**完全不消耗线上配额**。
- 局限（诚实标注）：不做物理推进，验证不了移动/伤害/资源消耗的真实语义 —— 这部分只能靠轨道 D。

### 轨道 C —— 客户端 Simulation 模式（人工）

- 官方客户端内的本地模拟，跑真实引擎，且有**独立于 World 的分支** → 线上玩家唯一的本地安全试验场。
- 用 `deploy.mjs` 把代码推到 sim 分支（同样消耗 `POST /api/user/code` 配额），在客户端里人工观察。
- 适合验证"新策略在小世界里到底会不会动"这种 A/B 都答不了的问题。

### 轨道 D —— World 线上观察（真实世界）

- 激活分支 → `watch.mjs` 盯 console → `stats.mjs` 采指标。
- **回滚预案是硬前提**：保留一个已知可用的分支，出问题时 `set-active-branch` 切回（每次操作 1 个配额，一次部署+回滚合计 4 个配额）。
- 上线节奏：小步、可观测、可回滚。

> **诚实标注的能力边界**：去掉私服后，**无法在本地验证引擎物理语义**（移动耗时、伤害结算、资源消耗速率、结构耐久）。这部分只能靠轨道 C/D 的真实世界反馈，因此 M1–M3 的策略必须**保守**：优先选择行为可预测的简单动作，避免把复杂假设直接压到线上试验。

---

## 5. 里程碑与验收标准

| 里程碑 | 对应状态 | 内容 | 可观测验收标准 |
|---|---|---|---|
| **M0 基础设施** ✅ | — | 仓库骨架、构建/类型检查/单测/部署/观测命令、token 连通性与 shard 自动识别 | **已达成**：`typecheck`/`lint`/`test`(8 passed)/`build` 全绿；`whoami` 自动识别 shard3 与 CPU 20；守卫规则经反例测试确认会拦截违规。`deploy`/`watch`/`stats` 均已实测（部署 1/240、console 流、段读取）|
| **M1 内核骨架** ✅ | — | tick 管线、CPU 预算与降级、cache/heap/memory/stats/log/errors/profiler | **已达成**：54 单测通过；`npm run smoke` 跑真实产物 200 tick × 2 相（常规 + CPU 高压），9 项断言全过——含**降级确实触发**与**关键阶段从不被跳过**；Memory 迁移幂等；stats 段写入且有界 |
| **M2 任务系统 + 角色** ✅ | — | 任务注册表与租约、角色行为表、状态机、spawn manager | **已达成**：任务租约全生命周期单测覆盖；真实房间 W34S1 回放断言意图序列；**线上实测闭环**：harvester 采满 → 交付 spawn → upgrader 出生 → 控制器进度开始增长（`prog 2→3`）。⚠️ **creep 死亡后的自动补员尚未实测**（需等 1500 tick 寿命到期） |
| **M3 `BOOTSTRAP`→`ESTABLISHED`** 🔄 | RCL 1–5 | 容器/存储、RCL 升级、builder/upgrader 配比、body 按能量自适应、状态迁移判定 | **进行中**：RCL **1→2 已完成**（实测）；extension 建造规划已上线并在建（实测 build +4/tick）；RCL 升级与建造同时推进（实测 RCL prog +1/tick）。待办：RCL 3 的容器建造、2000 tick 无断档验收。⚠️ 未验证：creep 死亡后补员 |
| **M4 `MATURE`** | RCL 6–7 | link 链路、专用 miner、物流分层、**届时再设计** | RCL 6+；link 生效后 CPU 不升反降 |
| **M5+ 扩张与对抗** | RCL 8 | claim、远程开采、防御、Power Creeps —— **细节刻意不在此规划** | — |

### 5.1 线上实测基线（2026-09-10，shard3）

| 指标 | 实测值 | 说明 |
|---|---|---|
| **tick 速率** | **约 4 秒/tick** | 与 `gameShardsInfo.lastTicks`（3521–4428ms）吻合。**这是所有时间预估的基础** |
| 房间 | `W34S1`，controller(43,17)，spawn(24,10)，2 sources，62 walls | — |
| 移速 | 约 2 tick/格 | `nonmove/move = 2/1`，与体力公式一致 |
| RCL 1→2 预估 | 约 580 tick ≈ **39 分钟** | 单 upgrader、50 能量/趟、每趟约 145 tick |

**修正的一个真实效率 bug**（实测发现）：角色原本「一有能量就出发」，harvester 采 4 能量走 5 格去交付 —— 控制器进度因此长期为 0。改为**装满再移动**后吞吐提升约 10 倍（容量 50 vs 单 tick 采 4）。同理应用于 upgrader 与 builder。

**修正的一个配比错误**：BOOTSTRAP 原本按「每 source 一个 harvester」补员，导致在造出 upgrader 之前先造第二个 harvester。而 RCL 1→2 只要 200 能量却解锁 5 个 extension（+250 容量，+83%），是前期回报最高的单步。

**RCL 2 后的实测数字（t=82878392–426）**：

| 指标 | 实测 |
|---|---|
| RCL 进度 | 约 **1/tick**（2 个 upgrader） |
| 建造进度 | 约 **4/tick**（builder 1 WORK × 5 建造力） |
| **extension 单价** | **3000 能量/个**（我此前误把容量 50 当造价 → 5 个共 15,000） |
| RCL 2→3 | 45,000 能量 |
| 合计需 | 约 60,000 能量 ≈ **45 小时**（4s/tick） |

**一个真实张力（非 bug）**：建造按 1:1 消耗能量，故 builder 以 4/tick 吃掉全部收入（收入仅 1–2/tick），期间控制器进度停滞。这是资源竞争的正确表现，extension 完工后缓解。

**移动速率的关键实测**：`fatigue=4` 每两 tick ⇒ **3 tick/格** —— 那批 creep 是比率修复**之前**出生的（`work+work+carry+move`，3 个非 MOVE 对 1 个 MOVE）。修复后的比率（`move == 非 MOVE`）为 1 tick/格。这解释了「看起来像振荡、实为慢速移动」的现象。

> **M4 起刻意不做详细规划。** 远程开采、Power Creeps、市场这些内容，只有在 M3 指标达成、RCL 真的推到那一档时，约束条件（CPU 余量、房间地形、邻居威胁）才具体到可做设计。现在写细节等于对着想象写代码 —— 到 M4 开头单独出一版设计。
>
> 硬约束：M1 只交付上表内核服务 + 可观测性，**任何新增抽象都必须在 M3 的指标上有对应收益**。内核框架的最大风险是自我膨胀到永远没有可玩产出。

---

## 6. 部署与配额预算

### 6.1 环境与凭据

- `.env`（不入库，mode 600）：
  - `SCREEPS_TOKEN_DEPLOY` —— 需 `user/code` 权限（部署）
  - `SCREEPS_TOKEN_WATCH` —— 需 websocket console 事件权限（观测）
  - `SCREEPS_SERVER`（默认 `main`）
  - `SCREEPS_SHARD` —— **默认应留空**，留空即启用自动识别（见 §1.1.2）。显式设置时优先，但与检测结果不符会告警。
  - `SCREEPS_BRANCH`（默认 `default`）
- **不引 dotenv**：用 Node 内置 `process.loadEnvFile()`（20.12+）。
- **不用 `fromConfig()`**：它要求磁盘上存在 screeps 配置文件。改为手写构造
  `new ScreepsHttpClient({ server: { url, token }, app: {} })` —— 注意 `server.url` **必须是完整 URL**，否则 axios 拿到相对路径直接 `ERR_INVALID_URL`。
- token 拆分为两个角色，是为了缩小泄漏面，也便于分辨限流由哪条工作负载消耗。

### 6.2 命令

`npm run build` / `typecheck` / `test` / `deploy` / `watch` / `stats`

### 6.3 部署配额预算（240 次/天）

| 场景 | 单次成本 | 说明 |
|---|---|---|
| 一次部署 | 1（`POST /api/user/code`） | |
| 激活分支 | 1（`set-active-branch`） | 只有切换分支才需要 |
| 回滚到已知good分支 | 1 | |
| 完整"部署 + 激活 + 回滚" | 4 | 最坏情况预算 |

策略：

- **默认只推当前激活分支** → 一次部署 1 个配额，不额外消耗。
- **保留一个已知可用分支**作为回滚点；实验性改动推另一个分支，激活前先在 sim 分支验过。
- 单日部署上限设为 **60**（留 4 倍余量应对意外），`deploy.mjs` 硬性拦截超限。
- 需要高频迭代时，走 §1.2 的 **2 小时免限流窗口**（人工点击获取），此时放开发上限。

### 6.4 观测配额预算

- 统计拉取默认 60s 一次 → 1440 次/天，正好卡在 `GET /api/user/memory-segment` 的 360/小时（8640/天）**之内**，余量充足。
- 全量 Memory 转储仅在故障复盘时手动触发，不计入常态预算。
- WebSocket console 不占 HTTP 配额 → 常态观测尽量压在这个信道上。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **无本地真实引擎验证** | 物理语义（移动/伤害/资源）错误只能在线上暴露 | 轨道 A+B 覆盖决策与集成；M1–M3 策略保守；轨道 C（客户端 sim）做人工预验 |
| **线上无 staging 环境** | 坏代码直接作用于真实世界，可能赔掉 creep | 已知可用分支 + 即时回滚；小步部署；`set-active-branch` 成本仅 1 配额 |
| **部署配额 240/天被烧光** | 当天无法再修线上问题 | 离线验证过关才部署；`deploy.mjs` 硬限 60/天；必要时用 2 小时免限流窗口 |
| **观测配额 429** | 监控断档，故障时瞎眼 | 统计走 segment（6/分钟）；常态观测压 WebSocket；薄封装内置配额记账与 429 基线处理 |
| **CPU 20 是硬顶**（未解锁时 GCL 涨也不加 CPU） | M4/M5 的多房间方案在 20 CPU 下不可行 | 见 §8.1；在 20 CPU 内把单房间做到极致本身就是 M3 目标 |
| Memory 2 MB 与序列化成本 | 中后期性能崩塌 | M1 起禁止 per-creep Memory；情报与统计走 segment |
| **赛季重置 / 新分片** | 部署目标与策略失效；新分片 tick 更快 | shard/world 一律走配置项；赛季重置期是重构窗口 |
| 适配层被绕过 | 离线验证失去意义，退化为线上试错 | `domain/` 禁止 import `game/`，用 lint 规则硬性拦截 |
| 内核过度设计 | M3 长期无产出 | M1 硬性服务清单 + 新增抽象需 M3 指标支撑 |
| `@types/screeps@3.4.0` 与 TS 7.0.2 不兼容 | 类型门禁报错 | 回退并 pin TS 5.x；打包走 esbuild 不受影响 |

---

## 8. CPU Unlock —— 已由实测确定

**实测结论：本账号未解锁，`cpuLimit = 20`**（`gameShardsInfo()` 中 shard3 报 20，其余 shard 报 0）。

规则：未解锁时 CPU **固定 20**，GCL 提升**不会**加 CPU；解锁后每 GCL +10，上限 300。bucket 上限 10,000、单 tick 最多透支 500，所以 20 CPU 靠攒 bucket 能做**偶发**重算（PathFinder、远矿扫描），但扛不住**持续**多房间负载。

由此：

| 若 | 则 M4/M5 定义为 |
|---|---|
| **保持不解锁**（当前状态） | 在 20 CPU 内把**单房间**做到极致 + 极轻量远程开采。多房间扩张不现实 —— 但这是个有嚼头的约束，20 CPU 下的极限优化比堆房间更考验工程 |
| 购买 CPU Unlock | M4 多房间按原计划推进，M5 需加入"CPU 预算随 GCL 重算"逻辑（预算不再是个常数） |

**不影响 M0–M3** —— 20 CPU 正是 M3 的硬指标（CPU 峰值 < 20），先按不解锁做。

> 注：bucket 是可用的正收益来源。M1 的降级逻辑已按"预算 = `min(tickLimit, limit)`"实现（`src/kernel/tick.ts`），刻意**不**去借 bucket —— 借满 500 CPU 会让本 shard 其他玩家卡顿。若日后确认需要突发重算，再单独评估借用策略。

---

## 9. P0 执行状态与 M0 落地记录

### 9.1 已完成

| 项 | 状态 | 证据 |
|---|---|---|
| `git init` | ✅ | 提交 `7a5610c`、`a6bf7cf`、`dc5fdd7` |
| 仓库骨架 | ✅ | `package.json`(ESM) / `tsconfig.json` / `eslint.config.mjs` / `vitest.config.ts` / `scripts/` |
| 依赖安装 | ✅ | 167 包；TS 6.0.3、vitest 5.0.0、esbuild 0.28.2、screeps-api 2.1.0 |
| 四道门禁 | ✅ | `typecheck` / `lint` / `test`(8 passed) / `build` 全绿 |
| token 连通性 | ✅ | `authMe()` → `darkiiiiiice` |
| **shard 自动识别** | ✅ | 无配置即定位 `shard3`（见 §1.1.2） |
| 架构守卫 | ✅ | 反例测试确认 `@/kernel` import、`Game`、`Memory` 三类违规均被拦截 |
| `deploy` / `watch` / `stats` 脚本 | ⬜ 待补 | M0 剩余项 |
| 配额记账 | ✅ | `scripts/lib/quota-ledger.mjs` + `quotas.mjs`（待接入脚本） |

### 9.2 工具链实测坑（**后续会话务必先读**）

| 坑 | 现象 | 解法 | 已固化于 |
|---|---|---|---|
| **npm 12 默认禁 git 依赖** | `EALLOWGIT`：`isolated-vm@github:...` 被拒 | `--allow-git=all`（仅私服方案需要，现方案不涉及） | — |
| **npm 12 拦截 install script** | esbuild postinstall 未执行，`@esbuild/linux-x64` 二进制缺失 | `npm install-scripts approve esbuild` | 需在 README 记录 |
| **TS 7 无 lint 生态** | `typescript-eslint@8.70.0` peer 为 TS `>=4.8.4 <6.1.0`，且**无 v9**；TS latest 是 7.0.2 | **pin `typescript@~6.0.3`**。理由：工具链首要属性是"无聊且被支持"，且 @types/screeps 与 TS 7 兼容性未验证，而 esbuild 已负责转译、tsc 只做类型检查 | `package.json` |
| **TS 6 弃用 `baseUrl`** | `error TS5101`：baseUrl 将在 TS 7 停止工作 | 直接删除 `baseUrl`，`paths` 用相对路径 `./src/*` | `tsconfig.json` |
| **`"type": "module"` 让 CJS 产物失效** | 同样的字节，`.js` 里 `require()` 得到 `loop === undefined`，`.cjs` 里是函数 | 构建时写出 `dist/package.json` = `{"type":"commonjs"}`，保留约定文件名 `main.js` | `scripts/build.mjs` |
| **`screeps-api@2.1.0` engines** | `EBADENGINE`：要求 node `22.x \|\| 24.x`，本机 26.8.2 | 实测可用（仅告警）。留意后续版本是否收紧或用 Node 24 运行脚本 | — |
| **客户端构造方式** | `fromConfig()` 需要磁盘上的 screeps 配置文件，我们没有 | `new ScreepsHttpClient({ server: { url, token }, app: {} })`——**必须给 `server.url` 全 URL**，否则 axios 拿到相对路径报 `ERR_INVALID_URL` | `scripts/lib/client.mjs` |
| **v2 接口改名** | `ScreepsAPI`→`ScreepsHttpClient`，方法扁平化（`userOverview`/`userWorldStartRoom`/`gameShardsInfo`/`authMe`） | 已按 v2 写 | `scripts/lib/*.mjs` |

### 9.3 下一步（开局 → M2）

1. ✅ M0 收尾：`deploy.mjs` / `watch.mjs` / `stats.mjs` 已完成并实测（部署 1/240 配额记账、console 流、段读取）。
2. ✅ M1 内核骨架：`cache` / `heap` / `memory` / `stats` / `log` / `errors` / `profiler` 全部落地，54 单测 + smoke 双相验证通过。
3. **【需要你操作】在 shard3 的 `W55S5` / `W15N45` / `W35S5` 中选定一个放置首个 spawn** —— 世界状态 `empty`，没有 spawn 则 M2 起的验收无从谈起。
4. M2 任务系统 + 角色 + 状态机（`BOOTSTRAP`）：开局后即可推进。
