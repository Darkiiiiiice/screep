# Screeps: World AI —— 实施计划

> 目标：从零构建一套可持续演进、可回归验证的 Screeps MMO（screeps.com）AI 脚本。
> 决策基线（已确认）：仅上官方 MMO；TypeScript + esbuild 精简流水线；纯逻辑单测 + 真实引擎 tick 模拟双轨验证；首个里程碑是内核框架（调度/任务/状态机）；已具备账号与 token 生成能力。

---

## 1. 已核实的事实基线

| 事实 | 值 | 来源 |
|---|---|---|
| 官方引擎版本 | `@screeps/engine@4.3.2` | screeps/engine `package.json` |
| 默认 CPU | 20 ms/tick（未解锁）；bucket 上限 10000；单 tick 最多透支 500 | docs/cpu-limit |
| Memory 上限 | 2 MB，跨 tick 走 `JSON.parse/stringify` | docs/global-objects |
| 类型定义 | `@types/screeps@3.4.0`（2026-04 更新） | npm registry |
| 部署工具 | `screeps-api@2.1.0` | npm registry |
| 本地引擎模拟 | `screeps-server-mockup@1.5.1` → `screeps@4.3.0` → `@screeps/storage@5.1.3`（**lokijs 存储，无需 mongo/redis**） | npm registry 依赖链 |
| 本地引擎编译前提 | native 编译（`@screeps/driver@5.3.0` 钉 `isolated-vm` git commit）+ node-gyp 12；本机已具备 Python 3.14.7 / make 4.4.1 / g++ 16.2.1；`screeps@4.3.0` 要求 node>=22.9，本机 Node 26.8.2（ABI 147）满足 | npm registry + 本机探测 |
| 私服方案（后备） | `screepers/screeps-launcher`（Go，2026-09-07 仍在推）—— **自行管理 Node 版本**（默认 Node 24，可用 `nodeVersion` 指定）、自带 npm 包与 mod 安装；**默认存储即 `@screeps/storage`(lokijs)，不装 mongo/redis 也能跑**；`tickRate` 可配（下限 1000ms，官方警告过低会出问题） | launcher README |
| 官方路线图（2026） | 恢复 3 个月赛季重置；补 Power Creeps（Commander/Executor）；新分片（约 1s tick）；运行时升级到最新 Node，含**原生 ESM 与文件夹模块支持**、官方 VSCode 扩展 | 官方 2026 roadmap |

**对架构的两个直接推论**

1. 运行时即将支持原生 ESM + 文件夹模块 → 源码按 ES module 写、但**构建期仍打包成单文件 CJS** `main.js` 上传。等官方 ESM 落地后，只需去掉打包步骤、改为整目录上传，源码零改动。
2. shard / world 名称必须做成配置项 —— 赛季重置与新分片会改变部署目标。

---

## 2. 技术选型与目录结构

```
screep/
├── PLAN.md
├── package.json  tsconfig.json  eslint.config.js
├── scripts/
│   ├── build.mjs          # esbuild → dist/main.js（单文件 CJS）
│   ├── deploy.mjs         # screeps-api 推送（branch/shard/dry-run）
│   └── sim.mjs            # screeps-server-mockup 跑 N tick，收集 console/Memory
├── src/
│   ├── main.ts            # 入口：global 复用 + tick 生命周期
│   ├── kernel/            # 内核：与游戏内容无关的调度/预算/缓存
│   │   ├── tick.ts        # 阶段调度 + CPU 预算 + 降级
│   │   ├── cache.ts       # tick 级对象缓存（getObjectById / room 快照）
│   │   ├── heap.ts        # global 持久层（跨 tick、不进 Memory）
│   │   ├── memory.ts      # schema 版本 + 迁移 + GC
│   │   ├── log.ts         # 结构化日志 + 限流 + console 预算
│   │   ├── errors.ts      # 错误隔离 / 去重 / 上报
│   │   ├── profiler.ts    # 分阶段 CPU 统计
│   │   └── settings.ts    # 全部可调参数集中处
│   ├── game/              # 引擎适配层：唯一允许直接触碰 Game/Room/Creep 的地方
│   ├── domain/            # 纯逻辑：禁止 import game/，全部可单测
│   │   ├── tasks/         # 任务定义 / 注册表 / 生命周期（申请·租约·释放）
│   │   ├── roles/         # 行为策略（harvest/haul/upgrade/build/defend…）
│   │   ├── plans/         # 殖民计划：需求计算、配比、body 设计
│   │   └── economy/       # 能量流与物流配额
│   ├── colony/            # 组合层：把 domain 的决策落到 game 适配层执行
│   └── intel/             # 房间情报（M4 起）
├── test/
│   ├── unit/              # 轨道 A：fixture 单测（vitest，毫秒级）
│   ├── fixtures/          # Game/Room/Creep 打桩构造器 + 录制的房间快照
│   └── sim/               # 轨道 B：真实引擎 tick 模拟断言
└── dist/                  # 构建产物（不入库）
```

### 不可动摇的架构不变式

> **`domain/` 永不 import `game/`；`game/` 是唯一 import 引擎全局的层。**

这条不是洁癖：双轨验证的可行性完全建立在它之上。轨道 A 能毫秒级跑，是因为纯逻辑不依赖 `Game`；如果哪天某段逻辑绕过了适配层，轨道 A 就废了，验证成本瞬间回到"只能上线看 console"。

### 选型理由与版本

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript | `@types/screeps@3.4.0` 提供完整 API 类型；AI 规模到几千行后，API 误用是主要 bug 源 |
| 打包 | esbuild 0.28 → 单文件 CJS | 零配置、毫秒级增量；不用 rollup（starter 里的 rollup 2 + TS 4.8 已落后于 Node 26 生态） |
| 类型检查 | `tsc --noEmit` 独立于打包 | esbuild 只剥类型不做检查，类型门禁必须单独一步 |
| 单测 | vitest 5 | 原生 TS/ESM、watch 快；不用 mocha+ts-node 那套旧组合 |
| 引擎模拟 | screeps-server-mockup 1.5.1 | 唯一能"一次一 tick"推进真实引擎并读中间态的方案 |
| 部署 | screeps-api 2.1.0 | 官方 API 封装，支持 branch/shard |
| 不引入 | 任何社区 AI 框架（Overmind 等） | 黑盒内核会挡住 M1 的目标；但会借鉴其 CPU 预算与 cache 分层思路 |

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
  F --> G[cleanup<br/>GC + Memory 写回]
```

- 每阶段记录 `Game.cpu.getUsed()` 差值，进 `profiler`，tick 末统一输出。
- **降级**：当 `Game.cpu.getUsed() > tickBudget × 0.8`，按优先级表跳过后续低优先级阶段（如情报扫描、路径预计算），保执行与补员。
- **预算**：`tickBudget = min(Game.cpu.tickLimit, Game.cpu.limit + 允许的 bucket 借用)`，并预留约 12% 给 cleanup；bucket 低于阈值时禁止昂贵重算（PathFinder、远矿扫描）。

### 3.2 各内核服务

| 服务 | 职责 | 关键约束 |
|---|---|---|
| `cache` | tick 级 `getObjectById` Map 缓存、room 对象快照；跨 tick 只缓存静态数据（地形、CostMatrix）并按 `Game.time % N` 失效 | 不缓存可变对象引用跨 tick |
| `heap` | `global` 里的跨 tick 状态，以 id 为键 | 引擎重启会清空，任何 heap 数据都必须可从 `Game`/`Memory` 重建 |
| `memory` | schema 版本号 + 顺序迁移函数 + 死亡 creep 惰性 GC | 迁移必须幂等；每 tick 只 GC 一部分 |
| `log` | `log(scope, level, msg, data)`，同类消息限流 | console 有 CPU 成本且过量会被截断，必须有预算 |
| `errors` | 按「签名 + 位置」去重，仅在首次/每 N tick 输出；错误栈压进 `Memory` 环形缓冲（最近 50 条） | 单点异常绝不能中断整 tick |
| `profiler` | 分阶段 CPU + creep 数 + 内存大小的每 N tick 汇总 | 汇总本身有成本，用递增间隔 |

### 3.3 Memory 策略（从 M1 就锁死）

- `Memory` **只存**：schema 版本、任务租约、情报摘要、参数覆盖。
- **禁止 per-creep 状态**（`Memory.creeps.*` 只留角色与最小标记）。creep 个体状态走 heap 以 id 索引 —— 直接规避 2 MB 上限与每 tick 全量 `JSON.stringify` 成本。
- 大块情报（房间地图、CostMatrix）走 `RawMemory` segment，不进 `Memory`。

### 3.4 殖民地状态机（按 RCL 键控）

角色不是静态列表 —— 同一批角色在 RCL1 和 RCL6 该干的事完全不同（RCL1 无容器，只能 source↔spawn 直连搬运；RCL6 有 storage/terminal/link，需要物流层）。因此**房间行为由其 RCL 导出的状态决定**：

| 状态 | RCL | 结构前提 | 角色配比（示意） | 主要矛盾 |
|---|---|---|---|---|
| `BOOTSTRAP` | 1–2 | 无容器 / 刚出容器 | harvester 直接自采自送；1 个 upgrader | 能量总量不足，任何多余角色都会饿死 |
| `ESTABLISHED` | 3–5 | 容器、extensions | harvester 定点 + hauler 转运 + upgrader + builder | 物流效率；补员节奏跟不上消耗 |
| `MATURE` | 6–7 | storage、terminal、link | 引入 link 链路、专用 miner、物流分层 | CPU 预算与房间数同时上升 |
| `EXPANSION` | 8 | 全量 | 在 MATURE 基础上分出殖民/远程队 | 跨房调度与 CPU 分配 |

状态阈值直接取自官方 RCL 结构表（`docs.screeps.com/control.html`），这些数字就是状态迁移的判定依据：

| RCL | 升到下一级所需能量 | 该级解锁的关键结构 |
|---|---|---|
| 0 | — | 中立/未占领（仅 roads、5 containers） |
| 1 | 200 | **1 Spawn** ← 占领后即时可达 |
| 2 | 45,000 | 5 Extensions（50 容量） |
| 3 | 135,000 | 10 Extensions、**1 Tower** |
| 4 | 405,000 | 20 Extensions、**Storage** |
| 5 | 1,215,000 | 30 Extensions、**2 Links** |
| 6 | 3,645,000 | 40 Extensions、3 Links、**Extractor、3 Labs、Terminal** |
| 7 | 10,935,000 | 50 Extensions（100 容量）、**2nd Spawn**、4 Links、Factory |
| 8 | — | 60 Extensions（200 容量）、3 Spawns、**Observer、Power Spawn、Nuker** |

关键含义：

- RCL **1→2 只需 200 能量**，而 **2→3 要 45,000**（225 倍）—— 这是整个前中期最陡的性价比断崖。`BOOTSTRAP` 到 `ESTABLISHED` 的迁移判据必须围绕"何时能稳定产出 45k 能量"来定，而不是简单地看等级数字。
- 容器上限只有 **5 个**（RCL 0 起就是 5，之后不增），因此容器选址是**一次性决策**，选错了没有第二次机会 —— 这条要在 M3 里当成硬约束写进测试。
- `ESTABLISHED` 的能量累计目标：RCL 1→5 共需 200 + 45,000 + 135,000 + 405,000 = **585,200 能量**（即 M3 验收标准的由来）。
- Controller 在 RCL 1 的降级计时是 **20,000 tick**，这意味着"停更 upgrader"在 RCL 1 就有致命风险 —— 补员优先级里 upgrader 不能排太低。

- 状态**只由 `room.controller.level` + 实际建成的结构推导**，不存 Memory（可从 `Game` 重建，符合 §3.2 heap 不变式）。
- 每个状态声明自己需要的角色清单与数量；`domain/plans/` 按当前状态算需求，spawn manager 照单补员。
- 状态迁移是**单向且带滞后**（RCL 掉了或结构被拆，退回上一状态），避免在阈值上抖动。

这条设计同时是里程碑的排序依据 —— 见 §5。



### 轨道 A —— fixture 单测（快速、离线、确定性）

- 自建 `test/fixtures/` 打桩构造器，不依赖任何引擎包。
- 只断言**行为契约**：需求计算给出的配额、任务租约的互斥与释放、body 设计与可用能量的对应、优先级抢占顺序、内存迁移幂等性。
- 不写"检查字段被复制/默认值/转发"这类实现断言。

### 轨道 B —— 真实引擎 tick 模拟（集成、暴露物理语义）

- `screeps-server-mockup` 起私服（lokijs，无外部服务），`world.stubWorld()` 提供 9 房间，`addBot` 注入我们的 `dist/main.js` 作为 module，循环 `server.tick()`。
- 采集 `bot.on('console')`、`bot.memory`、`bot.newNotifications`，断言宏观指标（例：N tick 内首个 harvester 出生、M tick 内 RCL≥2、无 CPU 超限、无异常洪水）。
- **先决风险**：`isolated-vm` 需在本机 Node 26 上 native 编译成功。M0 第一件事就是验证它。
- **失败降级（轨道 B'）**：从 MMO 线上导出真实房间状态为 fixture，本地回放 `loop` 并断言"发出的命令序列"，不做物理推进 —— 仍能覆盖决策正确性，代价是丢掉移动/伤害/资源真实语义。

### 轨道 C —— 线上核对

- 只推 `dev` 分支，用 `screeps-api` 拉 console 日志与 Memory 快照核对；关键指标（creep 数、CPU 均值/峰值、RCL、Memory 大小）记入 `docs/live-metrics.md`。
- `main` 分支只在轨道 A/B 通过后才推送。

---

## 5. 里程碑与验收标准

| 里程碑 | 对应殖民状态 | 内容 | 可观测验收标准 |
|---|---|---|---|
| **M0 基础设施** | — | 仓库初始化、构建/类型检查/测试/部署/sim 五条命令、MMO token 连通性核对 | `npm run typecheck && npm test && npm run build` 全绿；`npm run sim` 跑 100 tick 并拿到 console；`screeps-api` `me()` 返回正确用户名与目标 shard |
| **M1 内核骨架** | — | tick 管线、CPU 预算与降级、cache/heap/memory/log/errors/profiler | 空内核连续 200 tick 稳定；profiler 输出各阶段耗时；注入一处故意抛错，tick 不中断且错误只上报一次；Memory 大小恒定 |
| **M2 任务系统 + 角色** | — | 任务注册表与租约、角色行为表、**状态机骨架（先只实现 `BOOTSTRAP`）**、spawn manager | 轨道 A 覆盖任务全生命周期（申请/抢占/超时释放）；轨道 B 中 creep 自主完成 harvest → deliver 全链，死亡后自动补员 |
| **M3 `BOOTSTRAP`→`ESTABLISHED`** | RCL 1–5 | 容器/存储、RCL 升级、builder/upgrader 配比、body 按能量自适应、状态迁移判定 | **连续 2000 tick 无 creep 断档**；RCL **1→5**（累计投入 585,200 能量）；CPU 峰值 < 20；Memory 波动 < 5% |
| **M4 `MATURE`** | RCL 6–7 | link 链路、专用 miner、物流分层、**届时再设计** | RCL 6+；link 生效后 CPU 不升反降 |
| **M5+ 扩张与对抗** | RCL 8 | claim、远程开采、防御、Power Creeps —— **细节刻意不在此规划** | — |

> **M4 起刻意不做详细规划。** 远程开采、Power Creeps、市场这些内容只有在 M3 指标达成、且 RCL 真的推到那一档时，约束条件（CPU 预算余量、房间地形、邻居威胁）才具体到可以做设计。现在写细节等于对着想象写代码 —— 到 M4 开头单独出一版设计。
>
> 硬约束：M1 只交付上表内核服务，**任何新增抽象都必须在 M3 的指标上有对应收益**。内核框架的最大风险是自我膨胀到永远没有可玩产出。

---

## 6. 部署与配置

- 环境变量（`.env`，不入库）：`SCREEPS_TOKEN`、`SCREEPS_BRANCH`（`main`/`dev`）、`SCREEPS_SHARD`。
- 命令：`npm run build` / `typecheck` / `test` / `sim` / `deploy`。
- 分支策略：`dev` 分支先在 MMO 上跑观察 → 轨道 A/B 通过 → 推 `main`。
- 回滚：保留上一版 `dist/main.js` 产物，`deploy` 支持指定本地文件回推。
- 构建产物：开发分支可选带 inline sourcemap 以便线上栈追踪；生产分支不带（省流量与体积）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `isolated-vm`（`@screeps/driver@5.3.0` 钉的 git commit）在 Node 26 编译失败 | 轨道 B 不可用 | **已在验证中**（`~/.cache/screeps-spike`）；失败则切 `screeps-launcher`（自带 Node 24，绕开本机 Node 26 的 ABI 问题），再失败切轨道 B'（fixture 回放） |
| `@types/screeps@3.4.0` 与 TS 7.0.2 不兼容 | 类型门禁报错 | 回退并 pin TS 5.x；打包走 esbuild，不受影响 |
| 内核过度设计 | M3 长期无产出 | M1 硬性服务清单 + 新增抽象需 M3 指标支撑 |
| **CPU 20 是硬顶**（未解锁时 GCL 涨也不加 CPU） | M4/M5 的多房间方案在 20 CPU 下不可行 | 见 §8 决策项；在 20 CPU 内把单房间做到极致本身即 M3 目标 |
| Memory 2 MB 与序列化成本 | 中后期性能崩塌 | M1 起禁止 per-creep Memory；情报走 RawMemory segment |
| 赛季重置 / 新分片 | 部署参数失效 | shard/world 一律走配置项 |
| 上线事故无法回滚 | 生产中断 | 只从 `dev` 分支观察通过后才动 `main`；保留上一版产物 |
| MMO 无沙箱试错 | 破坏性实验代价高 | 破坏性/高风险改动先在轨道 B 的私服世界验证 |

---

## 8. 需要你拍板的两件事（无法由代码或文档决定）

### 8.1 CPU Unlock —— 决定 M4 是否可行

官方规则：**未解锁时 CPU 固定 20**（`Game.cpu.limit`），GCL 提升不会加 CPU；解锁后每 GCL +10，上限 300。bucket 上限 10,000、单 tick 可透支最多 500，所以 20 CPU 靠攒 bucket 能做**偶发**重算（PathFinder），但扛不住**持续**的多房间负载。

- 若长期不解锁：M4/M5 应重新定义为"在 20 CPU 内把单房间做到极致 + 极轻量远程开采"，多房间扩张不现实。这其实是个挺有嚼头的约束 —— 20 CPU 下的极限优化比堆房间更考验工程。
- 若愿意解锁：M4 的多房间路线按原计划推进，但要在 M5 加入"CPU 预算随 GCL 重算"的逻辑。

**这不影响 M0–M3** —— 20 CPU 正好是 M3 的硬指标，先按不解锁做，届时再定。

### 8.2 是否接受 `screeps-launcher` 作为后备私服

它自带 Node 24（绕开本机 Node 26 的 native 编译风险），但会**自行管理一份 Node 运行时**并在项目外写入。若你不希望机器上多出一个自管 Node，我就只能选轨道 B'（fixture 回放，丢掉物理语义）。

---

## 9. 立即执行（P0 前置验证）

1. ~~`git init`~~ 已完成（`7a5610c`）。
2. **验证本地引擎**（进行中）：`~/.cache/screeps-spike` 正在 `npm i screeps-server-mockup`，即在验证 `isolated-vm` 能否在 Node 26 编译 —— 决定轨道 B 是否成立。
3. **验证 MMO 连通**：用 `screeps-api` 调 `me()`，确认 token 有效并记录目标 shard 名称。

第 2、3 项任一失败都会改变后续方案，因此必须先做完再进 M1。
