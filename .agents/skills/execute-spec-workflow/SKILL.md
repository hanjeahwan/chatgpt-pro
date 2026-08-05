---
name: execute-spec-workflow
description: 协调已经成形的 Spec 从实施输入准备、Ready Commit、Orca child worktree、IMP 执行、验证、Code Review 到集成的完整生命周期。用于用户明确要求按 `docs/specs/*.md` 实现并提交、继续或恢复既有 Spec 实施、按 `WORKFLOW.md` 执行，或收口 Spec 的验证、Review 与集成时；不用于创建或修订产品规格，也不定义任务账本 schema。
---

# 执行 Spec 工作流

以宿主 Agent 作为协调员，按仓库 `WORKFLOW.md` 的角色、状态标识和 Gate 合同推进实施。任务身份、依赖、状态和证据以对应 `docs/execution/*.tasks.json` 为准。

## 1. 检测当前状态

开始或恢复工作时，先读取完整 `WORKFLOW.md`、目标 Spec、对应任务账本和当前工作区状态，并检查现有 Orca worktree、implementation terminal、Review Task 与 reviewer terminal。

记录能够从仓库和 Orca 当前状态证明的以下运行上下文：

- `BASE_SHA`；
- `READY_SHA`；
- implementation worktree、branch、`HEAD` 和 terminal；
- 当前可执行或待收口的 `IMP-*`；
- 根 Review Task、原 reviewer terminal 和未关闭 finding；
- 未完成验证及其外部资源。

缺失信息优先从任务账本、Git 和 Orca 当前状态恢复。无法唯一恢复时停止并报告，不得创建重复 worktree、terminal、任务或 Review 上下文。

## 2. 路由当前阶段

只读取当前阶段对应的 reference；阶段 Gate 通过后重新检测状态，再读取下一阶段。

| 当前状态                                                               | 读取并执行                           |
| ---------------------------------------------------------------------- | ------------------------------------ |
| 账本不存在、与 Spec 不一致，或尚未形成 Ready Commit／child 放行证据    | `references/prepare-and-dispatch.md` |
| Child 已放行，存在可执行 IMP、未收口验证或 implementation finding 修复 | `references/implement-and-verify.md` |
| 实现与验证已收口，等待首次 Review、复审、`check --final` 或集成        | `references/review-and-integrate.md` |

Spec 在执行中变化时，返回准备阶段增量对账。Review finding 需要修复时，先返回原 implementation terminal 执行实现与验证阶段，再回到原 reviewer terminal 复审。

## 3. 协作边界

- 角色职责、稳定标识和 Gate 以 `WORKFLOW.md` 为准。本 Skill 不建立第二套定义。
- 使用 `plan-spec-implementation` Skill 创建或增量对账任务账本；本 Skill 不复制其任务拆分、状态或脚本规则。
- 使用 `orchestration` Skill 协调 Task、Dispatch、消息和等待；使用 `orca-cli` Skill 操作 Orca worktree 与 terminal。本 Skill 只规定本仓库的阶段路由和执行协议。
- 每个 dispatch 完成后，以仓库、账本和 Orca 的当前状态重新判断下一阶段，不以旧对话摘要替代当前证据。

## 4. 停止与完成

任一 Gate 未通过时停在当前阶段，按对应 reference 的失败处理报告缺口。禁止跨过 Gate、伪造证据或把未运行验证报告为通过。

只有 `WORKFLOW.md` 的交付前检查全部通过、implementation branch 已集成且未验证项与剩余风险已报告时，才能声明整个工作流完成。
