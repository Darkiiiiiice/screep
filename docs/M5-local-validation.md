# M5 本地验证记录

M5（自主殖民与多房）四纵切已于 2026-09-20 完成本地验收；线上执行受 GCL1 硬约束
（99126/1000000 分，下一房名额需 GCL2）封锁，链条已按"名额不足时不浪费派兵"
口径在线上实证恒关，属设计行为。GCL2 到达为纯时间函数，届时全链自动点火，
列为线上观察项（与 M3 RCL4 先例一致）。

## 验收标准对照（PLAN §5 M5 行）

| 条款 | 证据 |
| --- | --- |
| 自动完成一个新房占领 | colonize 探针：colonizer t276 出生→t282-340 认领（台账双戳 claimedAt+lastColonizerDeathAt，快照剃刀第四例后改为台账取证） |
| spawn 建成 | 启动队 t351/360/369 派齐（满编 3 自停）→t400 自主落子（spawnTile minimax+割点守卫）→t480 落成 |
| 独立补员 | 窗口 2400：殖民房 t535 起自孵工人；t1902 启动队全员寿终清零后殖民房纯靠自养，t2401 仍 5 工人在册持续五代换代；控制器 RCL2 |
| 母房不因扩张崩溃 | 探针全程母房 progress 7136 持续增长；生命周期基底检查（人口地板/控制器服务）全绿 |
| 名额不足时不浪费派兵 | 线上 GCL1 实证 colonizer 门禁恒关（零派兵）；单测 gclFreeSlots=0 钉死 |

## 四纵切提交

1. `evaluateColonizeTargets` 殖民评估（比远矿更严：任何归属出局、生效外援预定按情报年龄折算后出局）— 探针 `--intel-probe` 扩 2 断言。
2. `colonizerSpawnNeed` 五重门（GCL 空额硬闸）+ `driveColonizers` 占领闭环 — `--colonize-probe`（GCL2 注入 2e6）。
3. `pioneerSpawnNeed` 令箭门 + `spawnTile` 选点 + `drivePioneers` 自驱（赶路/待命/落子/建造/喂蛋/毕业 spawnedAt）— 探针扩 4 断言。
4. `resolveEvaluationRoot` 评估根锚定（修殖民房入环后双榜距离缓存污染）+ 探针延窗 2400 扩 4 断言证独立补员。

## 关键设计事实

- 殖民房占领后凭 `controller.my` 自动进入主循环（防御/人口/物流/施工全接管），
  pioneer 被工人过滤器排除使殖民房视 0 工人紧急补员自孵——独立补员是主循环
  房间泛化的自然结果，非专用代码。
- 启动队毕业后门禁关闭不补员，全员自然老死清场；殖民地失格（非我方/不可达）
  退役，灭队冷却 300（§1 失败有界）。
- spawn 落成前殖民房 `spawns=[]` 走 `no-spawn-local-survival`，不误孵。
- spawn 工地 15000 能量在探针中以中途提能（db 注入 progress=14900，与 RCL bump
  同式）折入窗口；放置行为本身是断言点，建造时长不是行为问题。

## 门禁

- 类型检查/lint/构建/smoke 全绿；单元测试 101/101；场景矩阵 20/20
  （lifecycle recovery logistics logistics-construction logistics-failure
  traffic traffic-recovery fairness economy fairness-pressure cpu-stress
  multi-room maintenance defense progression intel miners claim remote colonize）。
- 线上部署 `06fe31711b6d` MATCH（commit `ac1324f`），rootRoom=W35S2 首评锚定，
  双榜完整，零新错误；监控基线 `artifacts/live/baseline-1789883277330`。

## 线上观察项（不阻塞收口）

- GCL2 到达后全链自动点火：殖民榜榜首（W35S1 自留预定/W36S2 无主）→ colonizer
  → 启动队 → spawn 落成 → 独立补员。
- 殖民房 RCL2+ 自放 scout、以盈余派 pioneer 支援姐妹殖民地（§3.14 口径，允许）。
- darkiiiiiice 对 W35S1 的武装竞争若升级，殖民榜武装过滤会自动避让，改由 M7 处置。
