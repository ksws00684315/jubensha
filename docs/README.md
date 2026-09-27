# 文档索引

状态说明：**有效**表示当前仍可作为计划、规范或操作指南使用；**已完成**表示这份报告或计划对应的文档工作已经结束；**已作废**表示内容已被新文档取代。**实验性**表示已实现但存在已知缺陷，暂不建议用于正式环境。状态描述文档，不代表文中建议的功能都已实现。

| 文档 | 状态 | 内容 |
|---|---|---|
| [AI 酒馆实现对照与优化建议](ai-roleplay-optimization-2026-09-15.md) | 有效 | 当前实现对照及后续优化建议 |
| [主流 AI 剧本玩法调研与落地](ai-roleplay-research-2026-09.md) | 已完成 | AI 角色扮演机制调研与落地记录 |
| [全面审查整改计划](audit-fix-plan-2026-09-18.md) | 已完成 | 2026-09-18 审查问题及整改记录 |
| [Docker Compose 部署](deployment-docker.md) | 实验性 | standalone 镜像与 Compose 部署说明；容器内对局会停在搜证阶段，修复前请用 pm2 |
| [HTTPS 部署检查](deployment-tls.md) | 有效 | TLS 终止与反向代理部署要求 |
| [引擎债务整改计划](engine-debt-rectification-plan.md) | 已完成 | 回合执行器与终局事务整改记录 |
| [引擎玩法批计划](engine-gameplay-batch-plan.md) | 已完成 | 引擎玩法批次实施记录 |
| [工程优化计划](optimization-plan-2026-09-26.md) | 有效 | 当前工程优化迭代计划 |
| [工程优化进度台账](optimization-progress.md) | 有效 | 当前计划的步骤、指标与证据台账 |
| [试玩问题优化计划](playtest-optimization-plan-2026-09-21.md) | 有效 | 试玩问题修复与跨剧本验证计划 |
| [AI 角色扮演项目调研](research/2026-09-ai-roleplay-projects.md) | 已完成 | 基于一手来源的项目机制调研 |
| [剧本设计一手材料调研](research/2026-09-murder-mystery-script-design.md) | 已完成 | 剧本设计方法调研 |
| [剧本设计方法与优化手册](script-design-playbook-2026-09-15.md) | 有效 | 剧本创作、审稿和试演参考 |
| [剧本输入标准 V2](script-input-v2.md) | 有效 | 剧本语义数据标准 |
| [剧本全量审查第二轮](script-review-2026-09-round2.md) | 已完成 | 第二轮剧本审查报告 |
| [剧本审查报告](script-review-2026-09.md) | 已完成 | 2026-09-01 剧本审查结果 |
| [剧本结构性数据整改方案](script-structural-fix-plan.md) | 有效 | 剧本结构字段的后续整改清单 |
| [ADR 0001：单进程主控租约](adr/0001-单进程主控租约.md) | 有效 | 对局单写者租约决策 |
| [ADR 0002：状态版本化](adr/0002-状态版本化.md) | 有效 | 快照版本与迁移决策 |
| [ADR 0003：事件快照原子写](adr/0003-事件快照原子写.md) | 有效 | 事件与快照一致性决策 |
| [ADR 0004：开房授权与预算熔断](adr/0004-开房授权与预算熔断.md) | 有效 | 开房策略及模型预算决策 |
| [文档索引](README.md) | 有效 | 本目录文档入口 |

## 测试

仓库根目录 README 的「测试」一节列出 L1–L4 快速命令。L4 的 R4、R5 分段流程和安全注意事项见 [`scripts/e2e/README.md`](../scripts/e2e/README.md)。
