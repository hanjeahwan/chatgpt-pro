# Review 与集成

本阶段使用独立 reviewer 检查已实现范围，关闭 finding，收口任务账本并集成已验收分支。

## 1. 首次 Review

- 使用 `orchestration` Skill 在 implementation worktree 建立新的根 Review Task 和只读 reviewer terminal。
- 根 Review Task 的 `taskId` 标识本次 Review 上下文。
- Reviewer 使用 `open-code-review-delegate` Skill 审查当前 Spec 和 `BASE_SHA..HEAD_SHA`。
- 宿主 Agent 不得自审或传入自己的 Review 结论。

## 2. 修复与复审

存在阻塞 finding 时：

1. 宿主把 finding 交回原 implementation terminal。
2. 原 implementation terminal 修复 finding、重验并 commit。
3. 宿主在根 Review Task 下创建复审子 Task，并复用原 reviewer terminal。
4. 原 reviewer terminal 跟踪该 finding 及其修复引起的问题或证据缺口，直至明确关闭。

宿主不得直接修复 finding，也不得仅因 `HEAD`、Task、Dispatch 或复审轮次变化而新建 terminal。Reviewer 发现与原 finding 根因无关、也不是其修复影响或证据缺口的独立新问题时，宿主才建立新的根 Review Task 和 reviewer terminal。

## 3. 收口账本

Review 完成后，宿主把 Review Task、reviewer terminal 和结论交回原 implementation terminal。原 implementation terminal 更新任务状态和证据，并运行 `check --final`。

`check --final` 未通过时，根据缺口返回对应实施、验证或 Review 阶段，不得提前集成。

## 4. 集成

1. `check --final` 通过后，宿主确认 `READY_SHA` 是 implementation branch `HEAD` 的祖先，且 implementation worktree clean。
2. 宿主集成已验收的 implementation branch。
3. 发生冲突时，宿主把冲突交回原 implementation terminal 处理。
4. 冲突解决后，原 implementation terminal 重新运行受影响验证和 `check --final`，并提交结果。

## 5. 阶段完成条件

- 所有阻塞 finding 已由原 reviewer terminal 明确关闭；
- `check --final` 通过；
- 已验收分支已集成；
- 主工作区和 implementation worktree 没有非预期残留；
- 未验证项和剩余风险已明确记录。
