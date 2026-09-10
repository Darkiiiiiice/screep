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
| 本地引擎模拟 | `screeps-server-mockup@1.5.1` → `screeps@4.3.0` → `@screeps/storage@5.1.3`（**lokijs 内存存储，无需 mongo/redis**） | npm registry 依赖链 |
| 本地引擎编译前提 | native 编译（`@screeps/driver@5.3.0` 钉 `isolated-vm` git master）+ Python + base-devel；`screeps@4.3.0` 要求 node>=22.9，本机 Node 26.8.2 满足 | npm registry |
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

---

## 4. 验证双轨（+ 线上核对）

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

| 里程碑 | 内容 | 可观测验收标准 |
|---|---|---|
| **M0 基础设施** | 仓库初始化、构建/类型检查/测试/部署/sim 五条命令、MMO token 连通性核对 | `npm run typecheck && npm test && npm run build` 全绿；`npm run sim` 跑 100 tick 并拿到 console；`screeps-api` `me()` 返回正确用户名与目标 shard |
| **M1 内核骨架** | tick 管线、CPU 预算与降级、cache/heap/memory/log/errors/profiler | 空内核连续 200 tick 稳定；profiler 输出各阶段耗时；注入一处故意抛错，tick 不中断且错误只上报一次；Memory 大小恒定 |
| **M2 任务系统 + 角色** | 任务注册表与租约、角色行为表、需求/配比规划、spawn manager | 轨道 A 覆盖任务全生命周期（申请/抢占/超时释放）；轨道 B 中 creep 自主完成 harvest → deliver 全链，死亡后自动补员 |
| **M3 单房间经济自循环** | 容器/存储、RCL 升级、builder/upgrader 配比、body 按能量自适应 | **连续 2000 tick 无 creep 断档**；RCL 0→4；CPU 峰值 < 20；Memory 大小波动 < 5% |
| **M4 多房间扩张** | claim、远程开采、跨房物流、基础防御、情报分段化 | 第 2 房间达 RCL4；远程矿点稳定产出；情报走 RawMemory segment；CPU 仍在预算内 |
| **M5 对抗与性能** | 侦察、进攻/防守策略、bucket 利用、PathFinder 缓存 | 在 CPU 20 约束下支撑 M4 规模；单 tick 峰值不超 `tickLimit` |

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
| `isolated-vm` 在 Node 26 编译失败 | 轨道 B 不可用 | M0 第一步就验证；失败切轨道 B'（fixture 回放） |
| `@types/screeps@3.4.0` 与 TS 7.0.2 不兼容 | 类型门禁报错 | 回退并 pin TS 5.x；打包走 esbuild，不受影响 |
| 内核过度设计 | M3 长期无产出 | M1 硬性服务清单 + 新增抽象需 M3 指标支撑 |
| CPU 20 ms 预算不足 | 线上脚本被杀/行为截断 | 阶段降级 + 每 creep 执行预算 + bucket 感知；M3 硬指标 CPU 峰值 < 20 |
| Memory 2 MB 与序列化成本 | 中后期性能崩塌 | M1 起禁止 per-creep Memory；情报走 RawMemory segment |
| 赛季重置 / 新分片 | 部署参数失效 | shard/world 一律走配置项 |
| 上线事故无法回滚 | 生产中断 | 只从 `dev` 分支观察通过后才动 `main`；保留上一版产物 |
| MMO 无沙箱试错 | 破坏性实验代价高 | 破坏性/高风险改动先在轨道 B 的私服世界验证 |

---

## 8. 立即执行（P0 前置验证，约 30 分钟）

1. `git init` + `npm init`，装依赖：`typescript`、`esbuild`、`vitest`、`@types/screeps`、`@types/node`、`eslint`+`prettier`。
2. **验证本地引擎**：装 `screeps-server-mockup`，写一个 100 tick 的最小 bot 跑通 —— 这一步决定轨道 B 是否成立。
3. **验证 MMO 连通**：用 `screeps-api` 调 `me()`，确认 token 有效并记录目标 shard 名称。

三项任一失败都会改变后续计划，因此必须先做完再进 M1。
