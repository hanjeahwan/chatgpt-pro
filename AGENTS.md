# ChatGPT Pro Collab 仓库指南

本仓库实现一个通过 ChatGPT Pro Web 协作处理本地仓库的 Agent Skill。`AGENTS.md` 维护仓库级协作规则和权威文档导航；产品与 Skill 行为细节维护在对应权威文档中。

## 权威文档

- 面向用户的用途、用法和边界：`README.md`
- 产品行为、权限、技术合同和验收：`docs/specs/**/md`
- 跨规格或长期有效的架构决策：`docs/adr/adr-*.md`；创建 ADR 时遵守 `create-architectural-decision-record` Skill
- 代码规范：`CODE_STANDARD.md`
- 规格实现、验证、提交和验收流程：`WORKFLOW.md`

不要在多个文件复制同一完整规则：

- 产品行为改变时更新 Spec。
- 仅影响一份 Spec 的选择保留在该 Spec 的“决策记录”；跨规格或长期有效的架构决策记录为 ADR。
- Spec 依赖 ADR 时引用它，不重复其完整理由、替代方案和后果。
- 规格执行流程改变时更新 `WORKFLOW.md`。

## Markdown 文档格式

新建面向 Agent 或开发者的规范、流程和操作手册类 `.md` 文件时，默认沿用 `CODE_STANDARD.md` 和 `WORKFLOW.md` 的结构：

1. 文件顶部只使用一个 `#` 标题。
2. 标题后用一段简短导语说明用途、适用范围或触发条件。
3. 主体使用连续编号的 `## 1. ...` 章节；每节只承担一个读者任务。
4. 平行规则使用项目符号；执行顺序会改变结果时使用编号。
5. 文档包含执行、审查、验收或交付流程时，在末尾增加 `## N. <阶段>前检查`，使用 `- [ ]` 列出可判断的放行项。
6. 检查项之后使用“最终判断”“最终报告”或“完成条件”收口，标题按文档用途选择。

现有格式合同优先。短说明、README、Spec 和 ADR 不需要机械补齐不适用章节。

## 验证

普通代码改动运行：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```
