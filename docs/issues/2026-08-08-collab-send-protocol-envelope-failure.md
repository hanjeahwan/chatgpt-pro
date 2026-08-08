# Collab 发送附件的协议 envelope 间歇性缺失

本文件记录 `chatgpt-pro-collab` 显式附件发送在上传准备阶段间歇性返回 `parse upload-ready result: protocol envelope was not present`，导致任务被误判为失败的事件。本记录只承载已观察事实、已证明根因和后续验证边界，不预设修复实现。

## 1. 事件事实

- 日期：2026-08-08。原失败任务：`26cc97fe-9f8a-4be4-a70c-51b260f1f64f`。
- 首次发送使用一份 prompt 与一个已验证的 `.tar.gz` 附件。
- `send` 返回 `SUBMISSION_FAILED`：`parse upload-ready result: protocol envelope was not present; attachment cleanup failed: parse draft-cleared result: protocol envelope was not present`。
- 随后 `status` 返回 `taskStatus: failed`、`turnId: null`、`browserStatus: available`、`nextAction: none`。
- 原任务可以关闭。新任务 `2756c8b4-b8d6-4b1a-a493-4b726e84c1f9` 发送相同 prompt 与附件并获得有效 `turnId`。
- 后续验证发现相同附件重发在任务 `ce64b936-682c-409e-a6ab-79ba9a9dfe6e` 与 `9b5ec43a-5fe9-406f-9a69-3191a051e554` 再次失败，而 `f41eedd2-0839-4466-abe3-98e2fb2199db` 与已绑定任务 `a745d390-059c-4c8a-869b-3fc759d0e198` 成功——失败是间歇性的，与附件内容无关。
- 当前 `main`（`22bf585`）已把可证明安全的提交前失败改为清理/重建 composer、只失败 turn、提交 operation 并保持 task 活动；本 Issue 解决剩余的上传准备阶段间歇性假失败。

## 2. 根因与共同根因

- 直接根因（已在固定安装源核验）：产品固定 `@playwright/cli@0.1.17`。`browser_run_code_unsafe` 把页面函数包在 tab 的 `waitForCompletion` 中，而 `waitForCompletion` 调用 `_raceAgainstModalStates`：当点击 `Add photos & files` 在页面函数解析完成前发出 fileChooser modal 时，工具提前返回且不添加本次结果；`--raw` 模式下 CLI 随即输出空 stdout。若页面函数赢得竞速，则输出带引号的 upload-ready envelope。因此观察到的间歇性是 modal-handoff 竞速，不是随机 JSON 损坏。
- 下一个 Playwright `upload` 命令是固定 CLI 中设计用于消费并清除该 fileChooser modal 的操作（`browser_file_upload` 要求存在挂起的 fileChooser，在 `setFiles` 后清除该 modal state）。
- 原始 CLI 工具错误是纯文本结果，而现有协议失败格式化只保留 `### Error` 标记，因此清理错误可能被折叠为通用的“protocol envelope was not present”消息。
- 与 `2026-08-08-collab-recover-pending-file-chooser.md` 的共同根因：两案都处于 send draft 阶段（提交放行前）的浏览器层通道。不同入口：该 Issue 是自然 kill 后残留挂起 chooser 阻塞页面内清理（任务保持 `sending`）；本 Issue 是上传准备阶段的 modal-handoff 竞速造成假失败（任务被置为 `failed`）。
- 边界：chooser 悬挂、modal guard 与 modal-handoff 竞速以固定 `@playwright/cli@0.1.17` 为界，不做跨版本推断。

## 3. 影响

- 显式附件发送间歇性返回 `SUBMISSION_FAILED`，任务被误判为 `failed` 且 `nextAction` 为 `none`，宿主只能关闭任务并用新 task 重发。
- 间歇性不可预测，使附件发送的验证和重发流程不可靠；错误消息无法区分真实页面合同漂移与 modal-handoff 假失败。
- 已绑定 conversation 的任务同样受影响，不能保证绑定对话内的重发稳定成功。

## 4. 目标修复

以最简单的行为合同编码：

1. 显式附件发送中，返回有效 upload-ready envelope 的上传准备 run 即就绪。
2. fileChooser modal handoff 造成的空 run-code 结果只是暂定就绪：空输出单独从不证明成功，只有紧接着的 upload 命令成功才可证明就绪。
3. 非空非 envelope 输出或显式 CLI 工具错误是失败，不是暂定就绪。
4. 若立即 upload 无法证明成功，不得发生提交；既有 clean-or-rebuild composer 路径必须在失败 send 返回前证明安全 composer。安全恢复的 task 保持活动，允许一次后续显式 send。
5. 在宿主错误中呈现具体固定 CLI 错误，而不是折叠为通用 protocol-envelope 缺失。
6. 不增加重试、自动重发、新恢复状态机或推测性 fallback 层。

本修复只定义行为合同与验证边界，不预设实现；实现是否已存在以 checkout 为准。

## 5. 修复前验证条件

- [ ] 确定性可执行夹具：modal handoff 产生空准备输出，立即 upload 成功，且恰好一次 submit 跟随。
- [ ] 空准备输出后跟 upload 工具错误：不提交，调用 clean-or-rebuild，保留具体错误。
- [ ] 非空但畸形或不匹配的 envelope 仍属合同漂移。
- [ ] cleanup 成功、cleanup 失败与结构化 CLI 工具错误保持可区分。
- [ ] 一次真实显式附件发送验证恰好一个 user turn 与附件到达，并关闭 task/session。
- [ ] 现有 `pnpm check` 保持绿色。

完成条件：行为合同落到 Spec 并经上述夹具与实机复验后，实现与测试按合同交付。
