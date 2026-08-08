# WORKFLOW

本文件规定仓库开发任务的 Orca-native 闭环。任何写入开始前，Coordinator 必须从 target branch 创建专用 Orca task worktree。实施、验证和 Review 均在该 worktree 进行；除最终集成外，禁止直接写入 target branch（包括 `main`）或用户主工作区。Orca 命令、消息、等待和 worker 生命周期遵守版本匹配的 `orca-cli` 与 `orchestration` Skill；本文件只规定角色、交付边界和放行条件。

## 1. 核心流程

1. **建立任务环境**：Coordinator 创建 Orca task worktree，并通过 Orca Orchestrator 创建或绑定 Run。
2. **理解变化并拆分任务**：Coordinator 对照用户请求、适用 Spec 和现有实现，将工作拆为可独立实现、验证和提交的 atomic Tasks。
3. **派发实现**：Coordinator 按依赖顺序派发 Implementation Tasks。Implementation writer 交付对应 atomic commits，Coordinator 按 `orchestration` Skill 监督 Dispatch 直至结算。
4. **汇总候选与全量验证**：Coordinator 汇集已接受的 commits，在 task worktree 同步 target branch，并对最终 aggregate diff 执行完整检查。
5. **全量 Changes Review**：Coordinator 派发只读 Review Task。Independent reviewer 使用 `open-code-review-delegate` Skill 审查最终 aggregate diff。
6. **修正并集成**：Coordinator 将阻塞 finding 转为 atomic remediation Task，重复实现、验证和 Review。只有最终候选完成必要验证且没有阻塞 finding，Coordinator 才能集成。

## 2. Orca task worktree 与 Task

- Coordinator 从当前 target branch 创建一个专用 Orca task worktree。该 worktree 的 task branch 承载本次实现、commits、验证、Review 和 remediation。
- Coordinator 在写入前确认 task worktree clean，target branch 与起点 SHA 可由 Git 定位。
- Coordinator 将每个 atomic task 创建为 Orca Task，明确目标、write scope、验收条件、必要检查和前置依赖。这些内容保留在 Orca Task，不另建流程账本。
- Coordinator 保持单一 writer ownership。Implementation 或 remediation Dispatch 活动时，只有对应 Implementation writer 可以修改业务内容。
- Implementation writer 交还 ownership 后，Coordinator 可以同步 target branch。同步需要改变业务内容时，Coordinator 创建 remediation Task 并重新派发 Implementation writer。

atomic task 以一个完整、可验收的行为为边界，并包含交付该行为所需的测试和文档。前置依赖满足后，该 Task 应能独立实现、验证和提交。Coordinator 拆分行为目标，不预先设计具体代码或 commit 内容。

实施期间用户请求、Spec 或验收条件发生实质变化时，Coordinator 更新或替换受影响的 Orca Tasks 后再继续派发。仍满足新要求的 commit 可以复用。

Spec 增加或实质修订后，Coordinator 在拆分或继续派发前执行该版本 Spec 的 `执行前核对`，并按未决项的阻塞范围和处理方式决定受影响工作能否开始。Coordinator 直接以 Spec 的产品行为合同、产品边界、技术映射和 `验收与验证` 为依据，创建 Orca Task、执行 final candidate 验证和 aggregate diff Review。最后一次相关修改后，Coordinator 重跑必要或触发的 `VER-*`。Spec status 只表示规格生命周期，单独不决定工作的开始或完成。Coordinator 将执行状态保留在 Orca Task、Dispatch、验证和 Review。Review Task 授权 reviewer 读取实际绑定候选的验证结果和 Spec 要求直接检查的证据。

## 3. Implementation Dispatch 与 atomic commit

- Coordinator 使用 `orchestration` Skill 将 Implementation Task 派发给 `AGENTS.md` 定义的 Implementation writer，工作位置为本次 task worktree。
- Implementation writer 只修改 Task 的 write scope，并按 `CODE_STANDARD.md` 实现满足验收条件的最小完整改动。
- 每个 atomic Task 默认形成一个 atomic commit；若一个 Task 包含多个无关实现目的，Implementation writer 将其交回 Coordinator 重新拆分。
- Implementation writer 提交前检查 diff 并运行针对性检查，然后通过当前 Dispatch 的 `worker_done` 报告 commit SHA、实际检查和未解决问题。
- Coordinator 只接受属于当前 Task 和 Dispatch 的 `worker_done`。接受前，Coordinator 核对 commit SHA、write scope、检查结果、writer ownership 和 worktree 状态。

## 4. 候选与全量验证

Coordinator 按依赖顺序将已接受的 atomic commits 汇集在 task branch，然后同步当前 target branch。Coordinator 使用 Git 确定候选已纳入的 target SHA 和 final candidate HEAD，并核对它们之间的 aggregate diff。

Coordinator 在 final candidate HEAD 上执行仓库默认检查，以及任务、Spec 和实际影响要求的针对性或手动验证。未执行的检查必须说明原因和风险，不得描述为已通过。

## 5. Review Dispatch 与 remediation

1. Coordinator 将 `候选已纳入的 target SHA..final candidate HEAD` 创建为只读 Review Task，不授予 write ownership。
2. Coordinator 使用 `orchestration` Skill 派发 `AGENTS.md` 定义的 Independent reviewer。Review Task 明确要求 reviewer 使用 `open-code-review-delegate` Skill 选择文件、解析规则并 Review 最终 aggregate diff。
3. Reviewer 对照用户请求、适用 Spec 和验收条件，检查实现完整性、正确性、回归风险和 commits 组合后的集成问题。Review 默认针对最终 aggregate diff，不为每个 atomic commit 单独设置 Review Gate。
4. 存在阻塞 finding 时，Coordinator 创建 atomic remediation Task，重新授予 Implementation writer write ownership 并通过 `orchestration` Skill 派发。
5. Implementation writer 交付 remediation commit 后，Coordinator 重新运行受影响检查和必要的全量检查，再派发 Independent reviewer 使用 `open-code-review-delegate` Skill 复审最终 aggregate diff。

## 6. 集成前检查

- [ ] 全部实施、验证和 Review 均在专用 Orca task worktree 中完成；除最终集成外，未直接写入 target branch 或用户主工作区。
- [ ] 最终实现完整符合用户请求、适用 Spec 和验收条件。
- [ ] 所有 Orca Tasks 与 Dispatches 已结算，没有 writer 仍会修改最终候选。
- [ ] 所有 atomic Tasks 已形成对应 commits，候选已纳入的 target SHA、final candidate HEAD 和 aggregate diff 可由 Git 定位。
- [ ] 必要的全量验证已在 final candidate HEAD 上完成，未验证项已说明。
- [ ] Independent reviewer 已通过 `open-code-review-delegate` Skill Review 最终 aggregate diff，且没有未解决的阻塞 finding。
- [ ] 最终 diff 没有无关修改，task worktree clean。

集成前 target branch 已前进时：

- Coordinator 回到第 4 节重新同步和验证。
- 同步改变 aggregate diff 或 Review 上下文时，Coordinator 再执行第 5 节。
- 同步未改变 aggregate diff 和 Review 上下文时，Independent reviewer 确认同步后的 `target SHA..final candidate HEAD` 与已 Review 候选等价，无需重复完整 Review。

## 7. 完成条件

Coordinator 只在第 6 节全部通过后，按 `AGENTS.md` 的 Git 策略集成 final candidate。集成后，Coordinator 按 `orchestration` 与 `orca-cli` Skill 收口 worker 和 task worktree，并报告最终 commit 或 SHA 区间、实际执行的验证、Review 结论、未验证项和剩余风险。
