# 准备与派发

本阶段提交全部实施输入，通过 Ready Gate 与 Child Gate，从目标分支创建并放行唯一的 implementation worktree、branch 和 terminal，然后派发一个可连续实施的阶段。

## 1. 准备实施输入

1. 读取完整 Spec、相关代码、测试和当前工作区改动。
2. 使用 `plan-spec-implementation` Skill 创建或增量对账对应任务账本。
3. 提交 implementation worker 所需的 Spec、任务账本和其他实施输入。
4. 实施输入提交后，从仓库根目录运行一次任务脚本的 `check --ready`。
5. 确认实施输入没有遗留在未提交改动中。

账本与当前 Spec 摘要不一致、BEH/VER 覆盖不完整、依赖有环，或仍有 `blocked`、`invalidated` 任务时，不得继续。存在重叠改动、规格冲突、产品决定缺失或无法验证的要求时，停止并报告。`check --ready` 只在实施输入提交后运行一次，不在 child 中重复运行；对账修复后需要复验时，返回本阶段重新提交并再跑一次。

## 2. 创建并放行 Child

使用 `orchestration` Skill 编排协作，并使用 `orca-cli` Skill 从包含已提交实施输入的目标分支创建新的 child worktree、implementation branch 和 implementation terminal。

首次派发前只核对：

- child 起点包含已提交实施输入；
- implementation worktree、branch 和 terminal 均唯一；
- child worktree clean。

检查失败时按以下分支处理：

- **起点不包含实施输入**：返回准备阶段，提交遗漏的 Spec、任务账本或其他实施输入。
- **协作身份缺失或冲突**：停止派发，先恢复唯一的既有身份；确认不存在可恢复身份后，才从目标分支重新创建 child。
- **worktree dirty**：识别改动来源和负责人；保留有效改动并交回原负责人处理，不得通过删除或重建 child 丢弃改动。
- **child 创建或 terminal 启动失败**：回收本次未成功建立的资源，再从包含已提交实施输入的目标分支重试。

Implementation worker 不得在 child 中重新创建或替代准备阶段的 Spec、任务账本和其他实施输入。

恢复已有 child 时，先恢复唯一的 implementation worktree、branch 和 terminal，再核对起点包含已提交实施输入、协作身份唯一且 worktree clean。无法唯一恢复时停止，不得创建重复协作身份。

## 3. 派发连续实施阶段

一个 dispatch 连续处理所有可执行 IMP 和未收口验证，直到遇到明确 decision boundary：

- 产品决策（含 Spike 结论为 NO-GO/INCONCLUSIVE 或需要产品决定的未知项）；
- Spec 变化；
- 需宿主执行的外部验证；
- 阻塞 finding；
- 其他宿主明确声明的停止条件。

禁止为每个 IMP 单独派发，也不得在到达 boundary 前提前结束 dispatch。Implementation worker 遇到未知项时只报告，不自行创建或执行 Spike。后续阶段复用原 implementation terminal。

Dispatch 只提供：

- 当前阶段目标；
- implementation branch；
- 必需输入；
- 完成条件；
- 停止条件。

不得重复 `AGENTS.md`、`WORKFLOW.md` 或已引用 Skill 的完整指令。

## 4. 阶段完成条件

- 实施输入已提交，且 `check --ready` 已通过一次；
- Child 放行检查全部通过（起点、协作身份唯一、clean）；
- implementation worktree、branch 和 terminal 均唯一；
- 原 implementation terminal 已收到一个可独立判定的连续实施阶段。
