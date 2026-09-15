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
