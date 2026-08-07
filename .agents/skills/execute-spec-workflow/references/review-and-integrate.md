# Review 与集成

本阶段由协调员在实施者完成隔离 task branch 后检查当前目标分支，生成最终 integration candidate，完成双重验证，再由独立审查者检查候选并关闭 finding；最后由协调员核对证据并集成被审候选。

## 1. 确定 Integration Candidate

实施者完成 task branch 的实现和验证后，协调员才读取当前目标分支，并使用 Git 祖先关系选择集成路径：

- **目标分支仍是 task branch 的祖先**：直接使用 task branch 作为 integration candidate。
- **目标分支已经前进，默认线性历史**：从当前成果分支创建新的 integration branch/worktree，并由协调员把该候选 rebase 到当前目标分支。首次生成时，当前成果分支是 task branch；再次生成时，当前成果分支是上一版 integration candidate。
- **用户明确要求保留拓扑，或上游同步必须保留 merge 关系**：从当前成果分支创建新的 integration branch/worktree，并在该候选中合入当前目标分支。
- **生成候选发生冲突**：协调员把 integration candidate 交给实施者；实施者解决冲突、验证并提交，task branch 继续保存原隔离成果。

协调员使用 `git merge-base --is-ancestor <target-branch> <current-result-branch>` 判断目标分支是否仍是当前成果分支的祖先；Git 提交图是起点与祖先关系的运行时事实来源。

task branch 保存隔离任务成果，integration candidate 承担目标分支同步。首次候选从 task branch 派生；候选产生实现修复、Review finding 修复或账本收口提交后，后续候选从上一版候选派生，确保已完成的任务改动不会丢失。当前 integration candidate 是后续验证、Review 和集成的唯一对象。

## 2. 双重验证最终候选

1. integration candidate 与实施者已验证的 task branch 相同时，沿用实施者验证结论；候选发生变化时，实施者先重跑全部必需验证并更新账本证据。
2. 实施者验证通过并保持候选 worktree clean 后，协调员独立执行全部必需验证。
3. 任一验证失败时，把失败证据交回实施者修复；实施者修复并验证后，协调员再次独立验证。
4. 实施者和协调员均通过后，冻结 integration candidate 并进入 Review。

## 3. 首次 Review

- 使用 `orchestration` Skill 在 integration candidate worktree 建立新的根 Review Task 和只读 reviewer terminal。
- 根 Review Task 的 `taskId` 标识本次 Review 上下文。
- 审查者使用 `open-code-review-delegate` Skill 审查当前 Spec，以及当前目标分支到 integration candidate 的差异。
- 协调员不得自审或传入自己的 Review 结论。
- 审查者返回后，协调员确认 integration candidate 未变化。候选变化时本轮 Review 失效，并由同一审查者审查变化后的候选。

## 4. 修复与复审

存在阻塞 finding 时：

1. 协调员把 finding 交回实施者。
2. 实施者在 integration candidate 中修复 finding、重验并 commit。
3. 协调员独立重验受影响范围并重新冻结 integration candidate。
4. 协调员在根 Review Task 下创建复审子 Task。
5. 同一审查者审查新的临时 revision，跟踪该 finding 及其修复引起的问题或证据缺口，直至明确关闭。

协调员不得直接修复 finding，也不得仅因 `HEAD`、Task、Dispatch 或复审轮次变化而新建 terminal。审查者发现与原 finding 根因无关、也不是其修复影响或证据缺口的独立新问题时，协调员才建立新的根 Review Task 和 reviewer terminal。

## 5. 收口账本

Review 完成后，协调员把 Review Task、reviewer terminal 和结论交回实施者。实施者更新任务状态和证据，只提交对应任务账本的 Review 结论与状态，并再次确认 worktree clean。任何其他文件变化都会使本轮 Review 失效。

## 6. Integration Gate

协调员逐项检查非取消 IMP：

- `evidence.checks` 是否指向对应 BEH/VER 的可复现命令、结果或证据位置；
- `evidence.reviews` 是否指向 reviewer 上下文及明确结论；
- 证据是否能够证明验证发生在最后一次相关修改之后，且任务状态是否与证据一致。

证据语义核对失败时按以下分支返回：

- **实现或任务状态与证据不一致**：返回实现阶段；
- **检查证据缺失、过期、不相关或不可定位**：返回验证阶段；需要修改实现时继续返回实现阶段；
- **Review 上下文或结论缺失、不明确**：返回 Review 阶段。

证据语义核对通过后，实施者在 integration candidate 中运行 `check --final`；该命令只校验账本 schema、Spec 摘要、覆盖、依赖、状态和证据字段非空，不判断证据内容是否真实或相关。

`check --final` 未通过时按以下分支返回：

- **Spec 摘要、覆盖、依赖或 schema 错误**：返回准备阶段；
- **任务状态或检查证据字段错误**：返回实现或验证阶段；
- **Review 证据字段错误**：返回 Review 阶段。

`check --final` 未通过时不得提前集成。

## 7. 集成

1. `check --final` 通过后，协调员确认 integration candidate worktree clean；审查者接受后产生的差异只包含对应任务账本的收口提交。
2. 协调员确认当前目标分支仍是被审 integration candidate 的祖先，然后只使用 fast-forward 集成该候选。
3. Fast-forward 失败或祖先检查失败表示目标分支在候选生成后继续前进。协调员保留被审候选，并从该候选派生新的 integration branch/worktree，再按第 1 节同步当前目标分支。
4. 新候选重新通过双重验证、同一审查者复审、Integration Gate 和 `check --final` 后，协调员再重试 fast-forward。

## 8. 阶段完成条件

- task branch 完整保存 Spec、任务账本、实现和实施者验证形成的隔离成果；
- integration candidate 由协调员在实施者完成 task branch 后，根据当前目标分支生成；
- 实施者和协调员已依次验证最终 integration candidate；
- 所有阻塞 finding 已由同一审查者明确关闭；
- Integration Gate 已通过（证据语义逐项核对 + `check --final`）；
- 审查者接受的 integration candidate 和账本收口提交已 fast-forward 集成；
- 主工作区、task worktree 和 integration worktree 没有非预期残留；
- 未验证项和剩余风险已明确记录。
