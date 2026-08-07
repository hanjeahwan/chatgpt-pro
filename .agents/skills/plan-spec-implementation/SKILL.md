---
name: plan-spec-implementation
description: 为已经成形的新 Spec 创建稳定的实施任务账本，或在既有 Spec 增删、移动、改写 BEH/VER 后增量对账任务、依赖、状态和证据。用于用户明确要求拆分可验证实施任务、创建或更新 `docs/execution/*.tasks.json`、跨 Session 恢复任务跟踪，或 `execute-spec-workflow` 在 Ready Gate 需要对账时；不用于创建或修订产品规格，也不负责端到端实施编排或代码 Review。
---

# 规划 Spec 实施任务

把 Spec 中的稳定产品身份映射为独立的 `IMP-*` 实施身份。保留未受 Spec 变化影响的任务和状态，只重新判断实际受影响的任务。

## 1. 准备输入

1. 读取完整 Spec、`WORKFLOW.md`、相关实现、测试和当前工作区改动。
2. 从仓库根目录运行本 Skill `scripts/spec-tasks.ts`；始终根据已加载 `SKILL.md` 的绝对目录定位脚本，不假定全局安装路径。
3. 工作区存在重叠修改、Spec 有阻塞未决事项，或产品行为不足以拆分时停止，不代替用户修改 Spec。
4. 使用 `docs/execution/<spec 文件名去掉 .md>.tasks.json` 作为唯一持久任务账本。运行时计划只镜像当前任务，不充当事实来源。

## 2. 判断创建或对账

- 账本不存在时执行 `snapshot`，创建新账本：

  ```sh
  node <skill-directory>/scripts/spec-tasks.ts snapshot --spec docs/specs/<spec>.md
  ```

- 账本存在时先执行 `diff`，不得先重建或覆盖账本：

  ```sh
  node <skill-directory>/scripts/spec-tasks.ts diff --spec docs/specs/<spec>.md --ledger docs/execution/<spec>.tasks.json
  ```

- `contextChanged=true` 时检查 BEH/VER 以外的产品边界、技术承载或验证规则变化，并据此判断受影响任务。它可以与 `added`、`changed`、`removed` 同时出现，不得因为编号变化已经处理就忽略。
- `impactedTasks` 是由 `changed` 或 `removed` 确定性反查出的任务；仍需结合 `contextChanged` 判断其他受影响任务。

## 3. 拆分 IMP 任务

把一个 IMP 定义为可以独立实现、独立验证、独立提交，并能在失败后单独返工的最小行为切片。

- 按状态转换、实现机制、失败模式和验证边界拆分，不按文件数量或 BEH/VER 数量机械拆分。
- 多个 BEH 必须修改同一机制、共享同一验证且无法独立成立时合并。
- 同一 BEH 涉及可独立提交或验证的机制时允许由多个 IMP 覆盖。
- 每个必需 VER 只指定一个负责取得最终证据的 IMP；该 IMP 可以依赖其他任务。
- 使用 `dependsOn` 表达真实代码或验证前置，不按理想执行顺序制造依赖。
- `scope` 只记录组件或职责边界，不把可能变化的完整文件清单当作合同。
- 新任务使用当前历史最大 `IMP-*` 后的下一个编号。不得重排、重编号或复用删除、取消过的 ID。

任务状态只使用：`pending`、`in_progress`、`implemented`、`blocked`、`done`、`invalidated`、`cancelled`。`implemented` 表示实现提交与相关检查已经取得，可满足下游实施依赖，但全量验证或 Review 尚未收口；它不能替代 `done`。

## 4. 创建新账本

使用 `snapshot` 输出的 `spec`、`contextDigest` 和 `sourceDigests`，加入人工拆分的任务：

```json
{
  "spec": "docs/specs/example.md",
  "contextDigest": "sha256:...",
  "sourceDigests": {
    "BEH-001": "sha256:...",
    "VER-001": "sha256:..."
  },
  "tasks": [
    {
      "id": "IMP-001",
      "title": "实现可独立验证的行为切片",
      "status": "pending",
      "covers": ["BEH-001"],
      "verifies": ["VER-001"],
      "dependsOn": [],
      "scope": ["Component boundary"],
      "evidence": { "checks": [], "reviews": [] }
    }
  ]
}
```

账本保存 Spec 路径与摘要，以及任务 ID、标题、状态、覆盖、依赖、scope 和证据；不复制 Spec 的需求正文或验收条件。机器 schema 和 Gate 校验以 `scripts/spec-tasks.ts` 为准。

## 5. 增量对账既有账本

根据 `diff` 结果逐项处理：

| Spec 变化                | 账本动作                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| 只移动章节               | 保留 IMP、状态和证据；更新 Spec 摘要                                                          |
| 新增 BEH/VER             | 映射到现有未完成任务或追加新 IMP                                                              |
| BEH/VER 内容变化         | 清空关联任务的旧证据，移出 `implemented`/`done`，重新设为 `pending`、`blocked` 或 `cancelled` |
| 删除 BEH/VER             | 删除对应引用并清空关联任务旧证据；失去全部目标的任务设为 `cancelled`，其余任务重新判断        |
| 非编号边界或技术合同变化 | 根据实际影响处理关联 IMP，不得因编号未变而忽略                                                |

`contextChanged` 识别出的任务按相同规则清空旧证据并重新判断。完成任务调整后，用当前 `snapshot` 值替换 `contextDigest` 和 `sourceDigests`。未受影响任务的 ID、状态、依赖和证据保持原样；不得整体重生成账本。

## 6. 校验与交回

账本调整完成后，从仓库根目录运行一次 `diff`，确认与当前 Spec 无残余差异：

```sh
node <skill-directory>/scripts/spec-tasks.ts diff --spec docs/specs/<spec>.md --ledger docs/execution/<spec>.tasks.json
```

- 本 Skill 只创建或对账任务账本，不运行 Ready Gate。`execute-spec-workflow` 在每个实施输入版本提交后，从仓库根目录运行一次 `check --ready`。
- 实现提交到 task branch 后记录相关检查；每项 VER 通过后记录可复现命令或证据位置。
- 实现已提交到 task branch 且相关检查完成后把任务设为 `implemented`；下游任务可依赖 `implemented` 或 `done`，不必等待全量验证和 Review。
- Spec 在执行中变化时，执行流程把 clean task worktree 的写入权交回协调员；本 Skill 重新执行第 2、5、6 节增量对账受影响任务，并保留未受影响任务。
- Code Review 完成后记录 reviewer thread 或根 Review Task 及结论。实现、验证和 Review 证据齐全时把任务设为 `done`，再由 `WORKFLOW.md` 的 Integration Gate 独立核对证据语义。
- Integration Gate 核对通过后运行 `check --final`。该命令只校验账本 schema、Spec 摘要、覆盖、依赖、状态和证据字段非空，不判断证据内容是否真实或相关。
- 账本收口产生的纯状态或证据更新不得夹带 Spec 或实现变化。

## 7. 职责边界

- 不创建、修订或补写 Spec；产品变化返回上游规格流程。
- 不根据任务账本推断产品行为；发生冲突时始终以当前 Spec 为准。
- 不把章节序号、数组位置、commit 顺序或运行时计划 ID 当作稳定身份。
- 不为任务状态维护 Git revision 字段；task branch 是隔离实施成果的持久身份，integration candidate 由 `execute-spec-workflow` 在运行时通过 Git 生成和校验。
- 不删除历史任务来伪造完成，不为旧账本格式增加迁移或兼容分支。
- 本 Skill 不代替 `WORKFLOW.md` 的实现、验证、提交和 Review 流程。

## 8. 实施前检查

- [ ] 当前 Spec 与账本路径是否唯一？
- [ ] 每个 BEH 是否至少由一个非取消任务覆盖？
- [ ] 每个必需 VER 是否恰好由一个非取消任务负责？
- [ ] 任务依赖是否存在且无环？
- [ ] 已开始任务的依赖是否为 `implemented` 或 `done`？
- [ ] Spec 变化是否已经增量对账，而非整体重建？
- [ ] 账本是否已交回执行流程，且 Ready Gate 的 `check --ready` 由 `execute-spec-workflow` 在实施输入提交后运行？

完成条件：账本与当前 Spec 摘要一致，任务身份稳定、覆盖完整、依赖可执行，且没有 `blocked` 或 `invalidated` 任务进入实现；账本已交回执行流程，Ready Gate 的 `check --ready` 由 `execute-spec-workflow` 在当前实施输入版本提交后运行一次。
