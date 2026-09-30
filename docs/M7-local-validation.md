# M7 本地验证记录

M7（完整攻防）九纵切 + 两轮评审修订已于 2026-09-30 完成本地验收并部署上线
（bundle 哈希 `fb5fcbc34d66` MATCH）。线上战斗验收（真实敌方来犯时的全链表现）
属被动观察项——与 M3 RCL4 / M5 GCL2 先例一致，无真敌人不等于未完成模拟验收。

## 验收标准对照（PLAN §5 M7 行）

| 条款 | 证据 |
| --- | --- |
| 在可战胜目标场景完成任务 | assault/siege/kite 探针骑真武装敌兵（尾填缴械修复后 squatters 带真 30dps 火力）三连完胜收档：清场保持 25t 三重门 + 台账收档，全程零折损 |
| 劣势场景按预算撤退 | stalemate 探针：4 武装蹲守者 > 可战胜闸（攻击手上限+1 局部优势）→ 评估不进榜；deadline=3000 自立队定死超时撤退落台账 + 目标排除期 10000 断送兵循环；损失预算 ASSAULT_LOSS_BUDGET=1 一损即撤 |
| 母房经济与防御储备不被抽干 | combat/squad 探针：守卫/医疗孵化第一顺位但占比如闸（1:1 上限、损失预算 2 劣势不添兵），两波入侵歼敌全程主孵化不断；economy/fairness 矩阵全程绿 |

## 九纵切提交

1. **M7-1 机动防御**（`6c4cc57`）：guardSpawnNeed（武装入侵开票/劣势不添兵/交接 TTL200）+ driveGuards（扑咬/伤退塔疗/清场归位）+ combat 探针两波入侵实证。
2. **M7-2 守家小队**（`df9ea61`）：healerSpawnNeed（守卫已开赴才开票/确定性配对/贴后 2 环/最重伤优先/自身半血先撤）+ squad-probe 软 raider 补投实证守卫全程零阵亡。
3. **M7-3 拆预留远征**（`9da3491`）：evaluateRaidTargets/attackerSpawnNeed + driveRaiders 剥离链（attackController 接力），raid 探针两兵接力实剥 900 tick 压过自然衰减线。
4. **M7-4 升级值勤**（`2a626da`）：shipment 派单前按名字序切 3 条腿专跑控制器，治"全员喂缓冲、升级只剩 0.5/tick"尾闾失血；线上提速实证。
5. **M7-5/5b/5c 封印 sink 系列**（`da534b7`/`85f9d4d`/`2b9b6df`）：8 邻域无可及格建筑从派单板剔除（hasApproach）+ 放置守卫断根（preservesApproaches）+ walkableAt 补 solid 工地判定——线上 ext 封印致工人 250+tick 冻结实证的根治。
6. **M7-6 突袭小队**（`b8370a3`/`e72d628`/`4e8a2be`）：assault 阶段机纯决策 + driveAssault 台账 + assault-probe；完成三重门（曾目击+清场保持 25t+新鲜）防假完成；可战胜闸（armed≥上限不进榜）+全灭终态+集结格内缩。
7. **M7-7 突袭强化**（`4c0c985`/`6d310e4`）：boost 纯决策（部件口径=引擎 BOOSTS 表）+ muster 强化腿（先领料再开拔，无料/超时 300 即弃不拖任务）+ lab 能量 sink（收窄持料 lab/上限 300/rank 9）；boostCreep RCL<6 门槛实证，夹具直种 lab 簇掐 builder 挤兑源。
8. **M7-8/8b 围攻拆墙手**（`1c49792`/`63710e0`）：threat.structures 情报 + 拆墙手编成 + 完成判据围攻语义（拆完才收档）；引擎 dismantle rampart 重定向实证；deadline=3000 立队定死 + 排除期 10000。
9. **M7-9 远程拉扯**（`4973bb1`/`0cb71b8`/`431ff97`）：ranger [RANGED_ATTACK×2,MOVE×2] 编成 + 风筝驱动（>3 压环/<=3 先射后撤，等速追击均衡 d=3）+ 跨房同步双闸（squadAssembled 位置判据 + travel 期门格列队）；两轮评审修订：焦点集火（hits 升序+名字决胜）、医疗贴患满疗（48hps 淹没 60dps 焦点）、追兵轻量隔离（测量装置不得杀伤被测对象）、蹲守者尾填缴械修复、±45/±90 撤退候选、贴边 0..49。

## 关键机制实证（引擎考古三证）

- **INVADER_ID="2"**（processor.js:18-19）：user '2' creep 每 tick 自动跑 invaders/pretick——夹具敌兵行为是真引擎 AI（findAttack 咬路径最近敌对者+邻接攻击；flee 仅对无 ATTACK 远程），不存在"无 intent 提交路径"。
- **_recalc-body 尾填 hits**：种子战斗 creep 攻击部件必须放 body 数组尾（或 hits==容量），否则列首 attack 出生即缴械（haveAttack 恒假，追击/攻击意图全不触发）。
- **等速追击几何**：撤退触发必须在武器满射程缘（d<=3），旧 d<3 阈值均衡是 d=1 恒贴脸连咬（25t 逐 tick 轨迹石锤）；双向夹击破单轴风筝——环带断言只对清场后入场的专职追兵计。

## 门禁

- 单元测试 195/195；tsc 0 错；lint 0 警；smoke 绿。
- 场景矩阵 33/33（lifecycle recovery logistics logistics-construction logistics-failure
  traffic traffic-recovery fairness economy fairness-pressure cpu-stress multi-room
  maintenance defense intel progression miners claim remote colonize combat storage
  links linkplace mineral labs market factory squad raid assault siege kite stalemate）。
- 战斗四套件（assault/siege/kite/stalemate）真武装敌兵三连绿，蹲守战零折损。

## 线上观察项（被动）

- 真实入侵/攻击事件触发时的全链表现（防御响应、评估出兵、撤退预算、灾后重建）——combat/squad/assault/stalemate 套间已覆盖响应逻辑，线上首战后对照台账取证。
- 母房经济在真实战斗期的储备水位（损失预算闸是否被真实压力触及）。
