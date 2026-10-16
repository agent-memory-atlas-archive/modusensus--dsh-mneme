# dsh-mneme 与其他记忆工具的能力对比 / Capability Comparison

> 更新于 2026-10-16。对比基于各项目公开文档与源码（出处见文末），只比较**能力结构**，不回答「谁更准」——效果类问题请以各系统在公开基准上的实测为准。dsh-mneme 是为 DSH 设计的记忆插件（SQLite + Markdown 镜像、完全离线），同时自带独立服务：stdio MCP server（npm 包 `mneme-memory`，任意 MCP 客户端可挂载）与不开 DSH 的常驻 daemon（`dsh-mneme-serve`），第三方集成读写同一份记忆库；其余为通用记忆服务/库，定位不同，读表时请带着这个前提。

| 能力 | dsh-mneme | Zep / Graphiti | Mem0 | Letta (MemGPT) | Hindsight |
|---|---|---|---|---|---|
| 存储底座 | SQLite 主库 + 人类可编辑 Markdown 镜像 | 时序知识图谱（Neo4j / FalkorDB / Neptune） | 向量 + 图混合的抽取式记忆 | 自编辑记忆块（核心内存） | 四层仿生结构（事实/经历/观察/心智模型） |
| 检索 | BM25 + 图谱 + 会话热记忆，v0.8.4 起实体图第四路（RRF 融合） | 时序图遍历 + 语义 | 语义 + 关键词 + 图 | 递归检索 + 自编辑 | 四路并行（语义/BM25/图/时间）+ RRF + 重排 |
| 写入时 LLM 抽取 | 否（原文直存，巩固期才用 LLM） | 是（抽实体/关系） | 是（抽事实） | 部分 | 是（retain 抽实体/时间） |
| 离线巩固 | autoDream（快写慢巩固） | — | — | sleep-time compute（学术同源） | 观察沉淀 |
| 冲突处理 | 矛盾冻结 → 人工裁决队列 | 时序失效（边失效标注） | ADD/UPDATE 等操作 | 无专门机制 | 证据回传更新观察 |
| 遗忘 | heat 热度衰减降权 + 显式 archive/delete，无静默淘汰 | 边失效 | ADD/UPDATE/DELETE 操作 | 无 | — |
| 作用域隔离 | agent / workspace 双维 + opt-in 硬过滤 | 用户/会话分 graph | user/agent/run 多层 | 多 agent | memory bank 按 bank |
| 可审计性 | sha256 审计链 + 幂等重放 | — | — | — | — |
| 多宿主接入 | DSH 内直用 + stdio MCP（`mneme-memory`，任意 MCP 客户端）+ HTTP daemon（`dsh-mneme-serve`）+ 网页端桥接（[Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)） | 托管 API + SDK | SDK / API | API / server | SDK / API / MCP |
| 完全离线 | ✅（可配本地嵌入模型） | 需 LLM/嵌入服务 | 需 LLM | 需 LLM | 需 LLM |
| 许可证 | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |

**如何读这张表**

- 「—」不等于「差」：通用服务面向多租户在线场景，把裁决权交给调用方也是一种合理设计；dsh-mneme 的差异点在于**把记忆管理做成有账本、可人工复核、可回放的流水线**。
- 效果类问题（检索准不准、巩固有没有用）看各系统的公开基准与本项目自己的评测，本表不回答跑分。
- 许可证为 2026-10-16 各仓库 LICENSE 文件实文核对结果。

## Capability Comparison (English)

> Updated 2026-10-16. Based on public docs and source code (sources below). This compares **capability structure**, not accuracy — effect questions belong to public benchmarks and our own evals. dsh-mneme is a memory plugin designed for DSH (SQLite + human-editable Markdown mirror, fully offline) that also ships standalone: a zero-dependency stdio MCP server (npm package `mneme-memory`, mountable by any MCP client) and a DSH-free daemon (`dsh-mneme-serve`), so third-party integrations read and write the same library; the others are general-purpose memory services/libraries.

| Capability | dsh-mneme | Zep / Graphiti | Mem0 | Letta (MemGPT) | Hindsight |
|---|---|---|---|---|---|
| Storage | SQLite + human-editable Markdown mirror | Temporal knowledge graph (Neo4j / FalkorDB / Neptune) | Vector + graph, extraction-based | Self-editing core-memory blocks | 4-layer biomimetic (facts/experiences/observations/mental models) |
| Retrieval | BM25 + graph + hot session memory; entity-graph 4th path since v0.8.4 (RRF) | Temporal graph traversal + semantic | Semantic + keyword + graph | Recursive search + edits | 4 parallel strategies + RRF + rerank |
| LLM extraction at write | No (raw text stored; LLM only during consolidation) | Yes (entities/relations) | Yes (facts) | Partial | Yes (retain extracts entities/time) |
| Offline consolidation | autoDream (fast write, slow consolidate) | — | — | sleep-time compute (same academic thread) | Observation layer |
| Conflict handling | Freeze → human review queue | Temporal edge invalidation | ADD/UPDATE ops | None specific | Evidence-fed observation updates |
| Forgetting | Heat decay (down-weight) + explicit archive/delete; no silent eviction | Edge invalidation | ADD/UPDATE/DELETE ops | None | — |
| Scoping | agent + workspace dual-dim, opt-in hard filter | per-user/session graphs | user/agent/run layers | multi-agent | memory banks |
| Auditability | sha256 audit chain + idempotent replay | — | — | — | — |
| Multi-host access | in-DSH + stdio MCP (`mneme-memory`, any MCP client) + HTTP daemon (`dsh-mneme-serve`) + web-client bridge ([Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)) | hosted API + SDKs | SDK / API | API / server | SDK / API / MCP |
| Fully offline | ✅ (local embedding model supported) | needs LLM/embedding service | needs LLM | needs LLM | needs LLM |
| License | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |

**How to read this table**

- "—" does not mean "worse": general services target online multi-tenant settings where the caller owns adjudication; dsh-mneme's differentiator is turning memory management into an **accounted, human-reviewable, replayable pipeline**.
- Accuracy questions belong to public benchmarks and this project's own evals; this table does not answer them.
- Licenses verified against each repository's LICENSE file on 2026-10-16.

## Sources

- Zep: arXiv:2501.13956 · repo [getzep/graphiti](https://github.com/getzep/graphiti)
- Mem0: arXiv:2504.19413 · repo [mem0ai/mem0](https://github.com/mem0ai/mem0)
- Hindsight: arXiv:2512.12818 · repo [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
- Letta: [letta-ai/letta](https://github.com/letta-ai/letta)
- dsh-mneme: 本仓 README 与 [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md)
