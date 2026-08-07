# 准备与派发

本阶段先从目标分支创建隔离的 task branch/worktree，再在其中准备和提交全部实施输入，通过 Ready Gate 与 Child Gate，并把唯一写入权交给 implementation terminal。

## 1. 建立任务隔离

1. 恢复已有任务时，先从 Git 和 Orca 恢复唯一的 task branch/worktree；无法唯一恢复时停止，不得创建重复身份。
2. 新任务在首次写入任务专属 Spec、任务账本或其他实施输入前，从目标分支当前提交创建 task branch，并在唯一 task worktree 中检出该分支。

创建失败时回收本次未成功建立的资源，再从目标分支重试。task worktree dirty 时识别改动来源和负责人，保留有效改动并交回原负责人处理；禁止通过删除或重建 worktree 丢弃改动。

## 2. 准备实施输入

1. 在 task worktree 中读取完整 Spec、相关代码、测试和当前改动。
2. 使用仓库指定的 Spec Skill，在 task worktree 中写入或更新本任务所需的 Spec 和其他实施输入。
3. 使用 `plan-spec-implementation` Skill 创建或增量对账对应任务账本。
4. 把 Spec、任务账本和其他实施输入提交到 task branch。
5. 实施输入提交后，从 task worktree 根目录运行一次任务脚本的 `check --ready`。
6. 确认 task worktree 没有遗留的未提交改动。

账本与当前 Spec 摘要不一致、BEH/VER 覆盖不完整、依赖有环，或仍有 `blocked`、`invalidated` 任务时，不得继续。存在重叠改动、规格冲突、产品决定缺失或无法验证的要求时，停止并报告。`check --ready` 只在实施输入提交后运行一次，不在 Child Gate 中重复运行；对账修复后需要复验时，返回本节重新提交并再跑一次。

## 3. 放行 Child

使用 `orchestration` Skill 编排协作，并使用 `orca-cli` Skill 在已有 task worktree 中创建或恢复唯一的 implementation terminal。Child Gate 放行后，协调员停止写入 task branch；implementation terminal 成为唯一写入者。

首次派发前只核对：

- task branch/worktree 和 implementation terminal 均唯一；
- Spec、任务账本和其他实施输入已提交到 task branch；
- task worktree clean；
- 写入权已从协调员交给 implementation terminal。

检查失败时按以下分支处理：

- **协作身份缺失或冲突**：停止派发，先恢复唯一的既有身份；确认不存在可恢复身份后，才从目标分支重新创建 task branch/worktree。
- **实施输入缺失**：返回第 2 节，把遗漏的 Spec、任务账本或其他实施输入提交到 task branch。
- **worktree dirty**：识别改动来源和负责人；保留有效改动并交回原负责人处理，不得通过删除或重建 worktree 丢弃改动。
- **terminal 启动失败**：回收本次未成功建立的 terminal，并在同一 task worktree 中重试。

实施者不得重新创建或替代准备阶段的 Spec、任务账本和其他实施输入。

恢复已有任务时，先恢复唯一的 task branch、task worktree 和 implementation terminal，再核对实施输入已提交、协作身份唯一且 worktree clean。无法唯一恢复时停止，不得创建重复协作身份。

## 4. 派发连续实施阶段

一个 dispatch 连续处理所有可执行 IMP 和未收口验证，直到遇到明确 decision boundary：

- 产品决策（含 Spike 结论为 NO-GO/INCONCLUSIVE 或需要产品决定的未知项）；
- Spec 变化；
- 需协调员执行的外部验证；
- 阻塞 finding；
- 其他协调员明确声明的停止条件。

禁止为每个 IMP 单独派发，也不得在到达 boundary 前提前结束 dispatch。实施者遇到未知项时只报告，不自行创建或执行 Spike。后续阶段复用原 implementation terminal。

Dispatch 只提供：

- 当前阶段目标；
- task branch；
- 必需输入；
- 完成条件；
- 停止条件。

不得重复 `AGENTS.md`、`WORKFLOW.md` 或已引用 Skill 的完整指令。

## 5. 阶段完成条件

- task branch 已在首次任务专属写入前从目标分支创建；
- 实施输入已提交，且 `check --ready` 已通过一次；
- Child 放行检查全部通过（实施输入、协作身份、clean、写入权）；
- task worktree、task branch 和 implementation terminal 均唯一；
- 实施者已收到一个可独立判定的连续实施阶段。
