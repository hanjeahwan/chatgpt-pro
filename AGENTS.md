# ChatGPT Pro Collab 仓库指南

本仓库实现一个通过 ChatGPT Pro Web 协作处理本地仓库的 Agent Skill。`AGENTS.md` 维护仓库级协作规则和权威文档导航；产品与 Skill 行为细节维护在对应权威文档中。

## 权威文档

- 面向用户的用途、用法和边界：`README.md`
- 产品行为、权限、技术合同和验收：`docs/specs/*.md`；创建 Spec 时遵守 `define-product-spec` Skill
- 跨规格或长期有效的架构决策：`docs/adr/adr-*.md`；创建 ADR 时遵守 `create-architectural-decision-record` Skill
- 决策问题 Spike：`docs/spikes/*.md`；创建或执行时遵守 `create-spike` Skill
- 代码规范：`CODE_STANDARD.md`
- 唯一仓库级开发流程合同：`WORKFLOW.md`
- 问题修复的最小、必要、可验证流程合同：`PROBLEM_FIXING.md`

维护权威文档和指令时：

- 产品行为改变时更新 Spec。
- 仅影响一份 Spec 的选择保留在该 Spec 的“决策记录”；跨规格或长期有效的架构决策记录为 ADR。
- Spec 依赖 ADR 时引用它，不重复其完整理由、替代方案和后果。
- 文档引用 Skill 时，只说明适用场景和本仓库的额外约束；不得重复 Skill 已覆盖的命令、步骤或通用指令。
- 规范性指令只记录会改变执行者选择、动作或放行判断的约束；沿用既有默认行为或不采取额外动作时省略。

## 开发流程角色

- **Coordinator**：local coordinating session；使用 Orca Orchestrator 建立并监督 Run、Task 与 Dispatch，维护 writer ownership，处理 Spec 变化、target branch 同步、验证、Review 调度与集成。
- **Implementation writer**：Orca supervised worker，默认 Agent 为 `opencode`，只写入 Task 声明的 write scope。
- **Independent reviewer**：Orca supervised worker，默认 Agent 为 `pi`，Review 指定 SHA 区间并返回 findings。
- **Orca Orchestrator**：提供 Run、Task、Dispatch、Message 与可选 decision gate 的运行时生命周期和任务状态。

同一文件或共享状态范围同时只有一个 writer；只读调查可并行。Coordinator 在 context compact 或接手后，先读本地 checkpoint（worktree comment 或 `.orca-tmp/session-handoff.md`），再以 Orca runtime、Git、requirement source 和适用 Spec 校准。

## Agent 任务协作路由

根据用户请求匹配任务场景：

- **监督式协作**：例如“把任务拆成 A、B、C，交给多个 Agent。”使用 `orchestration`
  Skill。你负责监督并做最终汇总：建立或绑定 Run、创建 Task、派发 supervised worker；派发成功后保持当前模型回合，滚动执行版本匹配的有界 `check --wait` 消费 Run inbox 的 FIFO Delivery，直到 expected Dispatch 全部结算。每个 Delivery 的全部 Message 处理完、正式副作用完成后最后 ack，然后继续等待或按退出条件结束；timeout、空结果或 heartbeat 不是完成或失败。不得以 terminal monitoring、terminal input、terminal delivery 或 worker signal 代替 Orchestration Delivery。Worker 独立执行，只在真正阻塞、需要升级或完成时通过 Orca 联系 Coordinator。Coordinator 中断后只能显式从 Orca runtime 与未 ack Delivery 恢复，不承诺自动继续。循环的完整约束见 WORKFLOW.md 第 6 节。
- **完整任务交接**：例如“把这个任务交给另一个 Agent 完成，你不需要继续跟踪。”使用 `orca-cli` Skill。
- **普通 Orca 操作**：例如“创建一个 Worktree”“在当前 Worktree 启动新 Agent”或“读取指定 Terminal 的输出。”使用 `orca-cli` Skill。
- **边界不明确**：用户仅要求“交给另一个 Agent 或 Worktree”，但没有要求监督、等待或汇总结果时，按完整任务交接处理。

核心判断：任务转交后，当前 Agent 是否继续对执行过程和最终结果负责；继续负责时使用 `orchestration`，转移所有权或仅操作 Orca 资源时使用 `orca-cli`。

Coordinator 与 supervised worker 的关系不是 Git branch 关系。正式事件经 Run inbox 的 FIFO Delivery 投递，消费方式见 WORKFLOW.md 第 6 节；不以 terminal 轮询或读取代替 Delivery 等待。

## Git 与提交

- 新提交使用 Unicode Gitmoji，格式为 `<gitmoji> (<scope>): <summary>`；没有有意义的 scope 时省略 `(<scope>):`。
- 每个提交只使用一个表示主要意图的 Gitmoji，不再叠加 `feat:`、`fix:`、`docs:` 等类型前缀。
- 默认保持线性历史：任务分支在实施期间保持隔离；任务完成后，由协调员在同一任务分支上同步目标分支并执行 fast-forward 集成。
- 只有用户明确要求保留分支拓扑，或上游同步必须保留 merge 关系时，才能创建 merge commit。
- 创建 merge commit 时，在最终报告中说明原因。

开发流程的 task branch 隔离、目标分支同步、Review 和集成步骤以 `WORKFLOW.md` 为准。

## Markdown 文档格式

新建面向 Agent 或开发者的规范、流程和操作手册类 `.md` 文件时，默认沿用 `CODE_STANDARD.md` 和 `WORKFLOW.md` 的结构：

1. 文件顶部只使用一个 `#` 标题。
2. 标题后用一段简短导语说明用途、适用范围或触发条件。
3. 主体使用连续编号的 `## 1. ...` 章节；每节只承担一个读者任务。
4. 平行规则使用项目符号；执行顺序会改变结果时使用编号。
5. 文档包含执行、审查、验收或交付流程时，在末尾增加 `## N. <阶段>前检查`，使用 `- [ ]` 列出可判断的放行项。
6. 检查项之后使用“最终判断”“最终报告”或“完成条件”收口，标题按文档用途选择。

现有格式合同优先。短说明、README、Spec 和 ADR 不需要机械补齐不适用章节。

## 自审

任务完成前必须进行自审：

- 核对实现是否完整满足需求。
- 检查逻辑、边界条件、异常处理和安全风险。
- 确认代码符合项目现有结构、风格和约定。
- 避免无关改动、重复实现和过度设计。
- 执行适用的测试、构建、类型检查和静态检查。
- 检查最终改动，删除调试代码、临时内容和敏感信息。
- 不得将未执行的验证描述为已通过。
- 存在未验证项、已知限制或风险时，必须明确说明。

仅在实现、检查和验证均符合要求后，才能声明任务完成。

## 验证

普通代码改动运行：

```sh
pnpm check
```
