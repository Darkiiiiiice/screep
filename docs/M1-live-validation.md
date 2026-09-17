# M1 线上验证记录

2026-09-11：已部署到 shard3 当前激活的 default 分支，房间 W35S2。

## 回滚资料

`artifacts/live/baseline-1789128656071/backup.json` 保存部署前代码、Memory 和房间对象。该目录不入库。回滚只恢复代码，不覆盖已经变化的游戏 Memory。

## 验收结果

- **通过**：监控起始 tick `82903568`，结束 tick `82905170`，跨度 `1602` tick，99 次采样。
- **通过**：旧的 6 名单位全部退出，新 `worker-*` 单位完成接替；监控窗口内人口最低 4、最高 6，没有人口空窗。
- **通过**：心跳持续更新，99 次采样均未发现超过 10 tick 的心跳延迟；运行错误 0。
- **通过**：RCL2 控制器进度 `200 → 1800`，窗口内增加 `1600`；实时复核时进度已到 `2125`。
- **通过**：实时 segment 样本 CPU `1.11 / 20`，bucket `10000`，配置 issues 为空。现有采样工具尚未逐次保存 segment CPU，因此这不是完整 p95 统计。
- **通过**：线上仍为 `default` activeWorld，线上代码 hash 与部署 hash 一致；没有发生自动回滚。
- **未覆盖**：断粮、拥堵、敌袭、多房和全 spawn 丢失；这些属于后续里程碑或独立线上场景。

## 后台监测

`node scripts/live-monitor.mjs artifacts/live/baseline-1789128656071` 已完成每分钟采样，目标跨度 1600 tick，上限 180 次采样。不要同时启动第二个实例。

- 状态：`artifacts/live/baseline-1789128656071/monitor-summary.json`
- 原始记录：同目录 `samples.jsonl`
- 进程日志：`/tmp/opencode/m1-live-monitor.log`

连续三次心跳过期、没有工作单位或出现新的运行错误时，监控确认当前代码和激活分支仍与本次部署匹配，再恢复旧代码。通信失败与代码故障分开处理，连续五次通信失败会停止并记录 monitor-unavailable。

此监控是一次性验收工具，依赖本机进程持续运行；未接入系统服务。经济停滞通过控制器进度和实时复核判断，不会仅因单次进度停滞回滚。


## M3 部署（2026-09-15）

- 基线：`artifacts/live/baseline-1789459986985/backup.json`（部署前 M1 代码 21672B + Memory + 房间快照）。
- 上传：default 分支（当前激活分支，无需 setActiveBranch），bundle 30015B，配额 1/240。
- 部署后校验：`artifacts/live/baseline-1789460066197/` 线上 main sha256 `67a29595246dfc89` 与本地 `dist/main.js` 一致。
- 监控：`node scripts/live-monitor.mjs artifacts/live/baseline-1789459986985`（hub 进程 live-monitor）。健康比较对 `dist/main.js`（M3），回滚物料取自部署前基线（M1/M2 代码 21672B）——传入部署后基线会让回滚路径还原同一个坏 bundle，已由顾问指出并纠正。
- 首批样本：tick 82988177→82988209 持续推进，heartbeat 跟随 tick，workers=5，RCL=3，controller progress 3861，errors=0。
- 回滚：baseline-1789459986985 保存部署前代码；`deploy.mjs` 重传旧 bundle 即可回退（default 分支激活语义不变）。


## M3 维修抢占缺陷修复（2026-09-15,aa6c983）

- 缺陷：两个空置遗留容器 (4,7)/(5,7) 衰坏至 21.4% 触发 urgent 维修抢占（`URGENT_REPAIR_THRESHOLD=0.25`）,`logistics.ts` 的 `urgent` 门冻结全部 11 个工地；部署前旧工地即已停滞（M2 时代另一道余量门）。
- 修复：`selectRepairTarget` 的 urgent 改为 `ratio<0.25 && critical`;`critical` 由调用方按收益判定（矿工转运目标=源邻接，或有存量）。空置遗留容器只排队闲时维修，永不抢占建设。
- 回归门：维修探针改伤收益容器 + 预置 20% 空置遗留容器；旧 src 跑新夹具 FAIL、新 src 11/11 PASS;15 场景变体 136 检查 + 71 单测全绿。
- 部署：bundle sha256 `d74a66a38f8c`，配额 2/240;rollback 物料 `baseline-1789463116874`（修复前 M3 代码）。
- 线上证据（修复后 103 tick,baseline-1789463151595 → baseline-1789463550064):extension 工地 (23,19) +213 进度（冻结解除）;收益容器 (6,6) hits +4900 获修；空置 (4,7) 仅衰减未修（死重正确忽略）;controller 3961→4001;errors=0。


## Memory.creeps 幽灵清扫(2026-09-15,e8ec936)

- 缺陷:`state.workers` 表有 GC,但引擎 `Memory.creeps` 无人清扫;死 creep 的认领标记(minerSource/containerBuilder/repairTarget)长期残留,部署后实测 257 条 vs 6 活。
- 修复:`runBootstrap` 每 25 tick 顺带清扫 `Memory.creeps`(孵化中 creep 安全:`Game.creeps` 自 spawnCreep 起可见)。
- 线上证据:部署后 130 秒 `Memory.creeps` 257 → 6,幽灵归零;bundle sha `ec1f2981c9a6`;rollback 物料 `baseline-1789470816939`。
- ~~已知 flake 备案~~ 已根治:extension 实测 ~tick 2802 建成,而检查点设在 2799,3-tick 临界竞争导致跨代码状态偶红;检查点后移至 2899(阶段注入 3000 前留 100 tick 真实余量),连跑 3 次全绿。

## 检查再校准:容器存量时间窗判定(2026-09-17)

- 背景:M4 SCOUT 切片开发期 `test:intel` 报 "both source containers receive harvested energy" 红;同一代码行为两次运行末帧容器 A 存量 2 vs 0。
- 取证:快照序列显示供应容器 A 全程被搬运链抽空(702→1402 钉在 ~2),末帧点读等价掷硬币;断言语义是"两源容器都有交付",与瞬时值无关——判定失准成立。
- 修法:后半程任一时间窗快照各源容器曾有能量即过(更严:覆盖全程交付,不依赖单帧运气);记录于 scenario-worker.mjs 注释。

## 检查再校准:progression RCL2 段改时间窗(2026-09-17)

- 背景:M4-2 矿工切片矩阵中 progression 二次跑挂在 RCL2 段(ext≥5@2899);与前矿工代码跑(PRE)逐帧比对:两跑工人出生时刻完全相同直到 1936 vs 1937 差 1 tick,混沌放大至工地能量差千分、完工时点 2802 vs ~3350。
- 根因:mock 引擎 `Game.cpu.getUsed()` 测真实 CPU,任意扰动(新增 find/循环、机器负载)经降级门/时机差进入确定性引擎后混沌放大;RCL2 完工时间是分布不是常数。
- 修法:RCL2 扩展能力改窗口判定([2800,3899] 任一快照 ext≥5);规划器坏死(恒 3)仍必挂,门不弱化。同族第三例(容器存量、extension 检查点之后),模式统一:点读→窗口证据。
