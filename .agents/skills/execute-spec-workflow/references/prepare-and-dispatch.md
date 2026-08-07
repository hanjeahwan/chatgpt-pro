# 准备与派发

本阶段先从目标分支创建隔离的 task branch/worktree，再在其中准备和提交全部实施输入，通过 Ready Gate 与 Child Gate，并把唯一写入权交给 implementation terminal。

## 1. 建立任务隔离

1. 恢复已有任务时，从 Git 和 Orca 恢复唯一的 task branch/worktree；存在多个候选时报告冲突并等待协调员裁决。
2. 新任务在首次写入任务专属 Spec、任务账本或其他实施输入前，读取目标分支的起始 `HEAD`，再使用 `orca-cli` 显式指定该目标分支为 Git base，创建 task branch/worktree。
3. 创建后比较 task branch 的 `HEAD` 与第 2 步读取的起始 `HEAD`。两者相同时开始写入；不同时清理本次空 worktree，并从正确目标分支重新创建。

创建失败时回收本次未成功建立的资源，再从目标分支重试。task worktree dirty 时识别改动来源和负责人，保留有效改动并交回原负责人处理；禁止通过删除或重建 worktree 丢弃改动。

## 2. 准备实施输入

1. 在 task worktree 中读取完整 Spec、相关代码、测试和当前改动。
2. 使用仓库指定的 Spec Skill，在 task worktree 中写入或更新本任务所需的 Spec 和其他实施输入。
3. 使用 `plan-spec-implementation` Skill 创建或增量对账对应任务账本。
4. 把 Spec、任务账本和其他实施输入提交到 task branch。
5. 实施输入提交后，从 task worktree 根目录运行一次任务脚本的 `check --ready`。
6. 确认 task worktree 没有遗留的未提交改动。

账本与当前 Spec 摘要一致、BEH/VER 覆盖完整、依赖无环且没有 `blocked`、`invalidated` 任务时，准备进入 Child Gate。存在重叠改动、规格冲突、产品决定缺失或无法验证的要求时，记录缺口并停在准备阶段。每个已提交的实施输入版本运行一次 `check --ready`；对账修复后提交新版本并重新运行。

## 3. 实施中更新 Spec

1. 实施者停止受影响任务，提交已经完成且验证过的改动，并把 clean task worktree 的写入权交回协调员。
2. 协调员使用仓库指定的 Spec Skill，在同一 task branch/worktree 中修订 Spec。
3. 协调员使用 `plan-spec-implementation` 增量对账任务、依赖、状态和证据。
4. 协调员提交更新后的 Spec、任务账本和其他实施输入。
5. 协调员对新实施输入运行一次 `check --ready`。
6. Ready Gate 通过后，按第 4 节再次放行 Child，由原 implementation terminal 继续受影响任务。

实施者无法形成 clean 交接点时，报告未完成改动及重叠范围；协调员等待实施者收口交接点后再修订 Spec。

## 4. 放行 Child

使用 `orchestration` Skill 编排协作，并使用 `orca-cli` Skill 在已有 task worktree 中创建或恢复唯一的 implementation terminal。Child Gate 放行后，协调员停止写入 task branch；implementation terminal 成为唯一写入者。

首次派发前只核对：

- task branch/worktree 和 implementation terminal 均唯一；
- Spec、任务账本和其他实施输入已提交到 task branch；
- task worktree clean；
- 写入权已从协调员交给 implementation terminal。

检查失败时按以下分支处理：

- **协作身份缺失或冲突**：停止派发，先恢复唯一的既有身份；确认不存在可恢复身份后，才从目标分支重新创建 task branch/worktree。
- **实施输入缺失**：首次准备返回第 2 节；执行中更新返回第 3 节，把遗漏输入提交到 task branch。
- **worktree dirty**：识别改动来源和负责人；保留有效改动并交回原负责人处理，不得通过删除或重建 worktree 丢弃改动。
- **terminal 启动失败**：回收本次未成功建立的 terminal，并在同一 task worktree 中重试。

实施者不得重新创建或替代准备阶段的 Spec、任务账本和其他实施输入。

恢复已有任务时，先恢复唯一的 task branch、task worktree 和 implementation terminal，再核对实施输入已提交、协作身份唯一且 worktree clean。出现多个候选身份时列出冲突，由协调员确定唯一恢复对象后继续。

## 5. 派发连续实施阶段

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

## 6. 阶段完成条件

- task branch 已在首次任务专属写入前从明确的目标分支创建，且创建时两者 `HEAD` 相同；
- 实施输入已提交，且 `check --ready` 已通过一次；
- Child 放行检查全部通过（实施输入、协作身份、clean、写入权）；
- task worktree、task branch 和 implementation terminal 均唯一；
- 实施者已收到一个可独立判定的连续实施阶段。
