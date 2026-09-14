# screep

Screeps: World MMO AI — 纯官方线上（screeps.com）方案。

实施计划见 [`PLAN.md`](./PLAN.md)。M0 已完成，M1 核心自养闭环通过生命周期验收，补充能力仍在实施。`npm run verify` 执行快速门禁；`npm run test:lifecycle` 执行 3100 tick 自养与接替验证；`npm run test:recovery` 执行清空人口/能量/Memory 后的恢复验证。

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
| `npm run scenario -- <fresh\|legacy\|no-memory>` | 使用本地真实引擎跑 M0 场景并保存 `artifacts/scenarios/*/report.json` | 否 |
| `npm run verify` | 执行 M0 全部门禁和三个场景 | 否 |
| `npm run select-room` | 自动识别 shard、评分候选出生房并生成报告（dry-run） | 读取请求 |
| `npm run select-room -- --room W35S2 --execute` | 重新检查选址并通过 `gamePlaceSpawn` 放置 Spawn1 | 改变世界 |

### 首次自动选房

运行 `npm run select-room` 进行只读扫描。`world-start-room` 返回推荐区域中心，不保证中心有 controller；选择器扫描每个中心四个方向距离 3 的普通房间，排除已占领、预留、敌军、无 controller 和情报不完整的房间。不是对整个 shard 的穷举。

评分考虑 source 数量、到资源/控制器的八方向地形距离、核心附近可用空间与沼泽。选择平原 spawn 位置，要求足够邻接空间和到所有工作目标的连通性。当前尚未扫描邻居威胁或远期扩张潜力，地形距离未计入身体疲劳；报告明确保留这些限制。

```bash
npm run select-room                         # 只读扫描并输出推荐
npm run select-room -- --room W35S2          # 单房重新评估
npm run select-room -- --room W35S2 --execute # 重新评估后实际出生
```

执行需要 token 对 `game/place-spawn` 的权限。出生前再次检查世界为空和位置未变化；成功后读取房间对象验证 Spawn1。网络失败时先检查世界，避免盲目重试。该工具不会上传代码，也不会删除房间或执行 respawn。

M1 本地代码已具备采集、供能、孵化和升级能力，但本地改动不会自动替换线上代码。推荐结果记录于 `artifacts/bootstrap/selection-*.json`，执行时以重新扫描结果为准。

### M1 状态与验证

M2 已完成本地验收（默认关闭，`Memory.logisticsEnabled = true` 启用容器自动施工、定点采矿、孵化补能预约、统一移动仲裁和控制器升级服务窗口）：11 个场景变体 69 项检查全绿，详见 [M2 本地验证](docs/M2-local-validation.md)。测试命令：`npm run test:logistics`、`npm run test:logistics-construction`、`npm run test:traffic`。当前进入 M3。

`Memory.bootstrap` 保存按能力接管的工作单位状态、房间人口需求、孵化储备、阻塞原因、有限错误记录和 `heartbeat`。全局缓存清空不影响恢复；旧的 `Memory.creeps` 角色不会阻止接管。每 20 tick 输出 segment 0 统计。

`Memory.policy.reserveEnergy` 和 `targetEnergy` 控制有效储备与补能目标，按实际孵化容量限制，接替预算优先。`Memory.bootstrap.capabilities` 记录当前 CPU/GCL 与房间能力，失去视野保留未知状态；`policyIssues` 记录无效配置。扩张和攻击相关配置仍由后续里程碑消费。

调度以常态 CPU 上限预留 2 CPU 收尾，房间和 creep 分别轮转，避免固定排序造成饥饿。连续无进展三次后，任务暂停 25–200 tick 再探测，重试计数上限六次；库存发生实际变化时解除阻塞。`blocked`/`retryAt` 提供排障依据。

M1 使用通用工作单位建立自养闭环，当前目标为每 source 两个工作单位（最多六个），后续 M2 根据实际吞吐替换为矿工/运输岗位需求。M1 不创建建筑或远征。

2026-09-11 本地验收：3100 tick 中共 12 次工作单位出生，控制器累计投入 4857 能量，初始化后无人窗口为 0；600 tick 故障场景恢复到四名工作单位并继续升级。此结果不代表线上 CPU 或完整 M1 附加能力验收通过。

配置、能力快照与轮转/退避补充版亦重新通过 3100 tick 和 600 tick 恢复验证，单测增至 14 项。报告分别位于 `artifacts/scenarios/fresh-1789127729154-1048057/report.json` 和 `artifacts/scenarios/no-memory-1789127530859-1046296/report.json`。

生命周期测试约需十余分钟，显示每 100 tick 的人口与控制器进度；各运行使用独立端口和目录。`--recovery` 场景在 tick 200 删除人口、清空 spawn 能量和 Memory，仅留下一个可工作单位，用于验证自救条件。报告位于 `artifacts/scenarios/`。

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
