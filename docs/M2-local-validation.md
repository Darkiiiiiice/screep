# M2 本地验证记录

M2 已完成本地验收（69 项场景检查全绿）；实验开关仍为 `Memory.logisticsEnabled`，默认关闭。

## 已通过

- 类型检查、lint、19 项单元测试、构建和 smoke。
- 600 tick 已有容器与失效订单注入场景通过 8 项检查，包括交付的下一 tick 资源观测。
- 报告：`artifacts/scenarios/fresh-1789137949763-1121494/report.json`。

## 自动施工历史失败

- 首次 3100 tick：第一工地 1810，第二工地 0；临时分配施工单位不足以稳定推进。
- 改为固定施工岗位后再次运行 3100 tick：第一工地 2828/5000，第二工地 0；控制器进度 2636。双容器建成并获得能源的断言仍失败。
- 报告：`artifacts/scenarios/fresh-1789138271405-1124477/report.json`。
- 后续修复：按矿点保留独立施工岗位，装满后集中建造，在已有恢复人口后使用双 WORK 身体。
- 交通压力、依赖环与长期饥饿恢复尚未验收。

## 最新通过的自动施工验证

- 3100 tick 场景通过 7 项检查；2802 tick 快照中两个容器均已建成，能源分别为 862 和 376。
- 报告：`artifacts/scenarios/fresh-1789139367530-1132454/report.json`。
- 同版本 600 tick 失效订单恢复通过 8 项检查：`artifacts/scenarios/fresh-1789139448098-1133124/report.json`。
- 类型检查、lint、19 项单测、build 和 smoke 通过。
- 施工期仍存在控制器进度长暂停，虽然随后恢复且保底断言通过，尚不能视为长期饥饿调度验收。

## 交通计数与控制器保底修复

- 仅对同一目标、连续 tick、无疲劳且未移动的尝试累计堵塞；工作间隔和更换目标会重置计数。
- 重复堵塞使用最大 100 tick 的指数退避，真实移动后清除失败次数。
- 控制器进入降级紧急窗口时，物流让出执行权给 bootstrap 保底策略。
- 21 项单测、类型检查、lint、build、smoke 通过。
- 同版本 600 tick 物流恢复回归通过 8 项检查：`artifacts/scenarios/fresh-1789140780711-1143216/report.json`。
- 此回归未注入窄路拥堵；真实让行、依赖环及长期饥饿场景仍待实现和验收。

## 统一移动仲裁与升级服务窗口

- M2 开启时，bootstrap 与物流先登记路径的下一步，房间调度末尾统一提交移动；每单位每 tick 最多一个移动意图。
- 同目标格按连续等待时间竞争，检测占位依赖链，允许闭合环同时移动；静止单位阻断的链不提交冲突移动。
- 路径缓存有效期 5 tick，连续堵塞 3 tick 后重新计算并避开 creep；20 tick 无进展后释放运输目标并有界退避。
- 三名及以上单位时，控制器 200 tick 没有实际进展便保留一名升级服务单位；观察到进展才结束服务。
- 25 项单元测试通过；类型检查、lint、build、smoke 通过。
- 最终构建 600 tick 恢复场景通过 10 项检查，包括两 tick 内释放失效订单和三名单位后升级停滞不超过 400 tick：`artifacts/scenarios/fresh-1789141652145-1150758/report.json`。
- 真实引擎对向互换与意图清空探针通过 2 项检查：`artifacts/scenarios/fresh-1789141788697-1152152/report.json`。探针使用当前交通模块，报告单独记录其 bundle hash。
- 施工回归最终版本通过 8 项检查：`artifacts/scenarios/fresh-1789141657876-1150856/report.json`。
- 新增 `recoverDependencies` 领域模型和循环检测单测；后续运行时接入见下节。
- 施工期控制器进度仍有最长约 199 tick 的停滞，已由服务窗口断言覆盖；封闭窄路不可达故障和多消费者长期饥饿仍未完成。

## 运输订单依赖恢复

- 前置任务未完成或缺失都阻止执行；循环成员立即撤销预约，其他依赖等待 100 tick 后撤销。运输板随后按真实库存重建。
- 依赖故障次数保存在 creep Memory，依次退避 10/20/40 tick；第三次进入停止领取物流任务状态，保留阻塞原因，由 bootstrap 继续基础工作。观察到真实物流交付才重置故障次数。
- 领域测试覆盖重叠环、自环、缺失前置条件、等待期限与独立任务；28 项单测、类型检查、lint、构建、smoke 通过。
- 真实场景在第 400 tick 注入三单位订单环，两 tick 内解除并保留诊断，600 tick 结束前观测到交付增长；全部 13 项检查通过：`artifacts/scenarios/fresh-1789142931221-1161255/report.json`。
- 此实现覆盖运输订单之间的依赖；当前普通订单生成器不会主动创建跨采集、孵化、施工依赖。完整经济任务图及多消费者公平服务仍待补齐。

## 持续依赖故障终止验收

- 第 450、451、452 tick 向同一单位连续注入自环；第三次失败后直到 600 tick 结束，每 tick 验证停止状态、三次故障计数、存活和没有新运输订单。
- 全部 15 项检查通过：`artifacts/scenarios/fresh-1789143327654-1164604/report.json`。
- 故障单位 `worker-W0N1-271` 停止领取物流订单后，观察到 125 次 tick 间携能变化，证明仍执行资源动作；房间控制器累计进度 177、最长升级停滞 193 tick，人口没有断档。
- 新命令 `npm run test:logistics-failure` 包含原有失效目标、三单位循环与连续自环注入。场景不修改生产策略，仅新增故障及结果断言。

## 运输消费者等待权重

- spawn 和 extension 需求接入独立服务状态，按每 25 tick 等待增加权重；25 tick 有限服务窗口稳定目标排序，仅实际交付清除等待。需求消失时清理状态。
- 生存人口不足两名时 spawn 需求优先于普通等待权重；已有在途订单仍保留目的地。
- 2000 tick 领域竞争测试：三个持续消费者每 10 tick 竞争一单位能源，期间反复序列化恢复状态，每个消费者服务间隔均不超过 200 tick。
- 30 项单测及 typecheck、lint、build、smoke 通过。最新构建的 600 tick 故障回归通过 15 项检查：`artifacts/scenarios/fresh-1789189441189-1467831/report.json`。
- 上述公平期限只覆盖领域竞争测试，不代表含路径、CPU 压力及在途订单的真实引擎保证。施工/升级尚未统一到该运输消费者模型，多消费者引擎竞争与跨岗位经济依赖图仍未完成。

## 多消费者真实引擎公平性

- 公平探针使用两个 extension、四个工作单位和两个预置能源容器，在物流与生命周期逻辑下运行 600 tick；每 100 tick 保存精简快照，避免报告 I/O 干扰引擎。
- 两个 extension 均收到能源，最大等待分别为 64 和 55 tick，实际累计交付分别为 753 和 999；2 项引擎公平性检查通过：`artifacts/scenarios/fresh-1789280879616-2069794/report.json`。
- 复现命令：`npm run test:fairness`。
- 当前证据覆盖同房间运输消费者竞争；跨岗位施工/升级服务公平性、CPU 压力下的等待上限和多房间公平仍待补充。

## 运行验证

## 高人口负载与经济任务草案

- 600 tick、24 单位的同房间公平场景通过 2 项检查，两个 extension 累计收到 3104、1855 能源，最大等待均为 31 tick。报告：`artifacts/scenarios/fresh-1789307312848-2244154/report.json`。
- 此报告沿用最初命名 `cpuPressure`，实际仅增加人口，没有注入或证明 CPU 接近预算；复现参数已更名为 `--population-pressure`，命令 `npm run test:fairness-pressure`。不能据此宣称 CPU 压力验收通过。
- 经济任务领域草案支持五种岗位；只有显式确认应急替代路径可执行才解除依赖，随后重新计算依赖图。缺失执行者不因任务被标为紧急而自动变成可执行。
- 32 项单测通过。经济任务草案仍未接入房间任务生成、资源预约和执行；跨岗位经济恢复与真实 CPU 压力验收仍未完成。

## 运输任务图接入运行时

- `runLogistics` 现在为每个活跃单位构建 `haul:<name>` 经济任务（含等待时间、重试次数和载货优先级），统一由 `planEconomicTasks` 计算阻塞、释放与环检测；旧的双套依赖计算已移除。
- `Memory.logisticsTasks` 记录每单位任务的阻塞状态供观察，条目随单位消亡清理，保持有界。
- 统一后回归：600 tick 循环注入场景 13 项检查全部通过（环内租约两 tick 内释放、有界重试、控制器 400 tick 内恢复服务）：`artifacts/scenarios/fresh-1789349239702-2334943/report.json`。
- 接入范围仅限运输岗位；孵化/施工/升级任务仍未生成，跨岗位经济恢复仍未完成。

## 四类岗位经济任务图接入运行时

- 领域层新增 `src/domain/economy.ts`：`buildEconomicTasks` 将采集外的四类岗位统一为 `haul:`、`build:`、`spawn:`、`upgrade:` 任务节点；裸名字映射为运输任务，含 `:` 的 ID 直指其他岗位，保持注入兼容。
- 依赖语义：在建工地等待交付到该工地的运输（自然运行中尚无此类交付，仅注入可触发）；能量不足且有在途补给的孵化任务等待该补给；等待状态通过 `Memory.logisticsTasks` 的 `lastProgress` 跨 tick 持久，超 100 tick 释放。
- 释放的实际后果：孵化任务释放后写入 `Memory.spawnEscalation`，bootstrap 在 5 tick 窗口内以最低体型（[WORK, CARRY, MOVE]）无视储备强制出生；工地/升级释放目前仅为观测记录。
- 引擎探针（600 tick）：向无任务单位注入 `dependsOn: [build:<工地>]`，断言跨岗位依赖被记录并阻塞、且在等待上限内以 `dependency-timeout` 释放，3 项检查全部通过：`artifacts/scenarios/fresh-1789350931467-2416505/report.json`。复现命令：`npm run test:economy`。
- 已知限制：自然运行中工地不接收运输交付（板面 sink 不含工地），跨岗位环仅能由注入构造；孵化等待判定为"需要出生且养得起当前队列但能量不足"。38 项单测、600 tick 循环恢复 13 项检查、typecheck、lint、build、smoke 均通过（恢复回归：`artifacts/scenarios/fresh-1789351152591-2421481/report.json`）。

## 受限 CPU 预算下的公平性

- 引擎的 `Game.cpu.limit` 取自数据库 `users.cpu` 字段（默认 100）；公平探针加入 `--cpu-stress` 后在启动前把该字段压到 10，并追加 60 个压力单位，使每 tick 处理量接近执行上限。
- 600 tick 结果：`Memory.bootstrap.degraded` 在运行中被触发（执行预算被打满的直接信号），两个 extension 仍分别收到 7542 与 3374 能源，最大等待 28 与 39 tick，均低于 200 tick 上限。3 项检查通过：`artifacts/scenarios/fresh-1789353804567-22250/report.json`。
- 复现命令：`npm run test:cpu-stress`。降级模式下物流板停用、交付由 bootstrap 兜底，公平性依赖轮换游标而非运输调度；这是降级语义的可接受结果，已在文档中说明。

## 封闭窄路与不可达交通恢复

- 新增 `--traffic-recovery` 引擎探针（120 tick，独立场景）：竖井口袋 (31,18)-(31,20) 七面封墙仅留上方开口，CorridorWorker 目标死端 (31,20)，Blocker 占门 (31,19) 并于 t40 撤离，Sealed 目标为被墙完全封闭的 (40,25)。复现命令 `npm run test:traffic-recovery`。
- 修复 `src/game/traffic.ts`：主寻路回归引擎 `creep.pos.findPathTo`（引擎自带建筑成本矩阵，可达目标行为与最初实现一致）；仅当无绕行路线可达目标时改用本地改进步——只登记严格缩短剩余距离的邻格意图（空格优先，允许占用格以触发环旋转）；封死目标无改进步则驻停，由有界退避接管，不再无限振荡。
- 引擎事实：裸 `PathFinder.search` 默认只按地形计价（不含 spawn/extension 障碍与道路成本），曾使 worker 规划穿过建筑，物流控制器进度 190→84 回归；因此寻路主路径必须走引擎 findPathTo 语义。
- 探针 5 项检查通过：worker 在门口驻停、t41 与 Blocker 合法环旋转互换、t42 抵达死端；Sealed 在最近可达点驻停并以有界退避保持重试。报告：`artifacts/scenarios/fresh-1789361190769-162485/report.json`。
- 连带修复：孵化等待释放的应急出生原为固定最小身体；现按房间当前可负担体型出生（有容器工地且能源 ≥300 时出双 WORK 身体）。此前 construction 场景因 t302/t502 两次最小身体出生使早期劳动力减半，两个容器差约 275 建造点未完成；修复后出生时间线恢复为 t402/t702 双 WORK 身体，容器建成并累计 1132/1298 能源，8 项检查通过：`artifacts/scenarios/fresh-1789361947993-167392/report.json`。
- 上述版本完整回归 10 个场景变体（traffic-recovery/traffic/logistics/logistics-failure/economy/fairness/cpu-stress/construction/lifecycle/no-memory recovery）全部通过；39 项单测、typecheck、lint、build、smoke 通过。

## 多房间公平

- 修复跨房间任务记忆竞态：`Memory.logisticsTasks` 原为全局扁平表，两个房间在同一 tick 内重建各自的 `live` 任务集时会互相删除对方房间的任务记忆，使跨 tick 饥饿窗口（孵化等待释放、依赖超时释放）在多房间下永久失效。现按 `Memory.logisticsTasks[room.name]` 命名空间隔离，bootstrap 在房间失守时同步清理命名空间。
- 新增 `--multi-room` 引擎探针（600 tick，需要 `--lifecycle --logistics --fairness-probe`）：引擎内注入第二间房 `W0N2`（RCL1 控制器、双源、独立 spawn），验证双房间同 tick 运行下的公平性。复现命令 `npm run test:multi-room`。
- 5 项检查通过：两个控制器均被识别为 owned、双房间人口均维持（≥2）、双控制器均取得升级进度、双房间均完成引擎内出生、双房间的 haul 任务记忆互不覆盖。报告：`artifacts/scenarios/fresh-1789365656663-190850/report.json`。
- 场景快照新增 `roomB` 字段；`--economy-probe` 读取任务记忆改为聚合各房间命名空间。
- 修复后完整回归 11 个场景变体（含 multi-room）共 69 项检查全部通过；40 项单测、typecheck、lint、build 通过。

## 阶段建设者调度修复（progression-probe 驱动，原始注入节奏 3000/4300 不变）

- 症状：RCL2→RCL4 连续发展验收中 storage 工地 0 进度——工人工位标记被 miner 循环抢占、失效/超容工地标记不释放、旧阶段工地吸干全部建筑工人；且 `growthType` 放置链在塔仍是工地时回落到 extension，塔/storage 在建造侧失去"当前阶段"地位。
- 修复（src/game/logistics.ts，均带注释）：
  1. miner 循环跳过已标记 `containerSite` 的施工工人（抢占后施工循环永远无法回收）。
  2. 每 tick 每工地只允许一名建筑工；重复粘滞标记视为陈旧并清除。
  3. 超出控制器容量上限的幽灵工地释放其建筑工（不再空守永不完工的工地）。
  4. 建筑优先级改由**已放置工地**推导而非放置链：storage 工地在位时其余类型共享 3 人池、塔工地在位时其余共享 2 人池；塔/storage 工地可抢占 extension 建筑工，并豁免于"至少留一名搬运工"下限。
- 验证：progression-probe 11 项检查通过（原始 3000/4300 注入与 2799/4299/末尾检查点，注入 schedule 未动）；最终 tick 5501 storage 工地进度 504。14 个场景脚本 + 69 项单测 + typecheck/lint/build/smoke 全绿。报告：`artifacts/scenarios/fresh-1789445239994-13572/report.json`。

```sh
npm run test:traffic-recovery
npm run test:logistics
npm run test:logistics-construction
npm run test:traffic
npm run test:logistics-failure
npm run test:multi-room
```

两个物流命令都会先构建，避免使用旧 bundle；交通探针直接构建当前交通模块。场景报告包含 bundle hash 和运行选项。
