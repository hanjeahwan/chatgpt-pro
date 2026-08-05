# 准备与派发

本阶段形成唯一的实施输入提交，从该提交创建并放行 implementation child，然后派发一个可独立判定的实施阶段。

## 1. 准备实施输入

1. 读取完整 Spec、相关代码、测试和当前工作区改动。
2. 记录本次实施周期开始前的 `BASE_SHA`。
3. 使用 `plan-spec-implementation` Skill 创建或增量对账对应任务账本，并把 `BASE_SHA` 写入账本。
4. 从仓库根目录运行任务脚本的 `check --ready`。
5. 提交 implementation worker 所需的 Spec、任务账本和其他实施输入。
6. 确认实施输入没有遗留在未提交改动中，把提交后的 `HEAD` 记录为 `READY_SHA`。没有新增实施输入提交时，`READY_SHA` 为当前 `HEAD`。

账本与当前 Spec 摘要不一致、BEH/VER 覆盖不完整、依赖有环，或仍有 `blocked`、`invalidated` 任务时，不得继续。存在重叠改动、规格冲突、产品决定缺失或无法验证的要求时，停止并报告。

## 2. 创建并放行 Child

使用 `orchestration` Skill 编排协作，并使用 `orca-cli` Skill 从 `READY_SHA` 创建新的 child worktree 和 implementation terminal。

首次派发前确认：

- child `HEAD` 等于 `READY_SHA`；
- child worktree clean；
- child 中的 `check --ready` 通过。

任一检查失败时停止派发，并重新创建以 `READY_SHA` 为起点的 child。Implementation worker 不得在 child 中重新创建或替代准备阶段的 Spec、任务账本和其他实施输入。

恢复已有 child 时，确认 `READY_SHA` 是当前 child `HEAD` 的祖先、worktree clean，并重新运行 `check --ready`。

## 3. 派发独立阶段

每个 dispatch 默认只承载一个可独立判定的 `IMP-*` 或验证阶段。该阶段必须具有一个主要目标、一个完成条件和一个失败边界。

多个动作只有在共享同一准备条件、同一终态和同一失败处理时才能合并。后续阶段复用原 implementation terminal。

Dispatch 只提供：

- 当前阶段目标；
- 当前 `HEAD`；
- 必需输入；
- 完成条件；
- 停止条件。

不得重复 `AGENTS.md`、`WORKFLOW.md` 或已引用 Skill 的完整指令。

## 4. 阶段完成条件

- `BASE_SHA` 已写入任务账本；
- `READY_SHA` 已记录；
- Child 放行检查全部通过；
- 原 implementation terminal 已收到一个可独立判定的当前阶段。
