# Review 与集成

本阶段由独立审查者检查已实现范围，关闭 finding；协调员核对任务证据、收口任务账本并集成已验收分支。

## 1. 同步并冻结 Implementation Branch

首次 Review 前按顺序执行：

1. 实施者保持 worktree clean，并把 implementation branch rebase 到目标分支当前状态。
2. Rebase 产生变化时，实施者重跑受影响验证并更新账本证据。
3. 第 2 步产生文件变化时，实施者提交实现或证据更新；无论是否产生变化，都再次确认 worktree clean。
4. 协调员停止向实施者派发写任务，冻结 implementation branch。
5. 协调员只在当前 Review Task 中临时记录目标分支 revision 和 implementation branch revision；这些 revision 不写入 WORKFLOW 或任务账本。

## 2. 首次 Review

- 使用 `orchestration` Skill 在 implementation worktree 建立新的根 Review Task 和只读 reviewer terminal。
- 根 Review Task 的 `taskId` 标识本次 Review 上下文。
- 审查者使用 `open-code-review-delegate` Skill 审查当前 Spec，以及 Review Task 中目标分支 revision 到 implementation branch revision 的差异。
- 协调员不得自审或传入自己的 Review 结论。
- 审查者返回后，协调员重新读取 implementation branch revision。当前 revision 与 Review Task 记录不一致时，本轮 Review 失效，并由同一审查者审查新的 revision。

## 3. 修复与复审

存在阻塞 finding 时：

1. 协调员把 finding 交回实施者。
2. 实施者修复 finding、重验并 commit。
3. 协调员重新冻结 implementation branch。
4. 协调员在根 Review Task 下创建复审子 Task。
5. 同一审查者审查新的临时 revision，跟踪该 finding 及其修复引起的问题或证据缺口，直至明确关闭。

协调员不得直接修复 finding，也不得仅因 `HEAD`、Task、Dispatch 或复审轮次变化而新建 terminal。审查者发现与原 finding 根因无关、也不是其修复影响或证据缺口的独立新问题时，协调员才建立新的根 Review Task 和 reviewer terminal。

## 4. 收口账本

Review 完成后，协调员把 Review Task、reviewer terminal 和结论交回实施者。实施者更新任务状态和证据，只提交对应任务账本的 Review 结论与状态，并再次确认 worktree clean。任何其他文件变化都会使本轮 Review 失效。

## 5. Integration Gate

协调员逐项检查非取消 IMP：

- `evidence.checks` 是否指向对应 BEH/VER 的可复现命令、结果或证据位置；
- `evidence.reviews` 是否指向 reviewer 上下文及明确结论；
- 证据是否能够证明验证发生在最后一次相关修改之后，且任务状态是否与证据一致。

证据语义核对失败时按以下分支返回：

- **实现或任务状态与证据不一致**：返回实现阶段；
- **检查证据缺失、过期、不相关或不可定位**：返回验证阶段；需要修改实现时继续返回实现阶段；
- **Review 上下文或结论缺失、不明确**：返回 Review 阶段。

证据语义核对通过后，实施者运行 `check --final`；该命令只校验账本 schema、Spec 摘要、覆盖、依赖、状态和证据字段非空，不判断证据内容是否真实或相关。

`check --final` 未通过时按以下分支返回：

- **Spec 摘要、覆盖、依赖或 schema 错误**：返回准备阶段；
- **任务状态或检查证据字段错误**：返回实现或验证阶段；
- **Review 证据字段错误**：返回 Review 阶段。

`check --final` 未通过时不得提前集成。

## 6. 集成

1. `check --final` 通过后，协调员确认 implementation worktree clean；审查者接受后产生的差异只包含对应任务账本的收口提交。
2. 协调员只使用 fast-forward 把 implementation branch 集成到目标分支。
3. Fast-forward 失败表示目标分支与被审查 implementation branch 不再满足线性祖先关系。协调员把 implementation branch 交回实施者 rebase；实施者重跑受影响验证、更新并提交证据，再次确认 worktree clean。
4. 协调员重新冻结 implementation branch，由同一审查者审查新的 revision，重新通过 Integration Gate 和 `check --final` 后再重试 fast-forward。

## 7. 阶段完成条件

- 所有阻塞 finding 已由同一审查者明确关闭；
- Integration Gate 已通过（证据语义逐项核对 + `check --final`）；
- 审查者接受的实现内容和账本收口提交已 fast-forward 集成，未产生 merge commit；
- 主工作区和 implementation worktree 没有非预期残留；
- 未验证项和剩余风险已明确记录。
