# Collab 提交前中断的恢复无法处理挂起 file chooser

本文件记录一次 `chatgpt-pro-collab` 首轮发送在附件上传后、提交放行前被自然中断，页面残留挂起 file chooser（modal state），`recover` 无法自动清理，原 task 卡死在 `send:draft:prepared` 的事件。本记录只承载已观察事实、根因和后续验证边界，不预设修复实现。

## 1. 事件事实

- 日期：2026-08-08；实机证据：`~/.local/chatgpt-pro-collab/verification/2026-08-08-ver-003-full/report.md`（VER-003 full，P1 放行失败）。
- 失败 task：`119063e0-b5fe-4868-8b09-c726e2d0c02d`。附件 1 上传完成后、submit command 放行前对 send 进程自然 SIGKILL；kill 时 operation 为 `send:draft:prepared`，被中断的 send 已在 kill 前放行下一个 prepare-upload gate，orphan gate 在父进程死后继续运行并打开了 file chooser。
- 页面残留：composer 中 1 个附件 chip + 挂起 file chooser（CLI modal state）。
- `recover` 返回 `PLAYWRIGHT_CONTRACT_DRIFT: parse draft-cleared result: protocol envelope was not present`：固定 CLI 的 modal guard 拒绝 `run-code` 与 `reload`，`upload` 命令强制 `file` 参数、无法表达 MCP `browser_upload` 空 `paths` 的取消语义，draft 清理脚本永远无法执行。
- 卡死状态：turn 保持 `sending`、operation 保持 `send:draft:prepared`、`status.nextAction` 恒为 `recover`，再次 recover 必然再撞 modal guard。
- 安全生命周期处置（按协调人指示只尝试一次）：`status`（只读）→ `recover`（失败）→ `close` 一次成功；task `closed`、browser `missing`、无残留进程；从未产生 user turn，Web 侧无 conversation 可清理。
- 人工解除条件（备用，未执行）：(a) 通过 MCP 直接调用 `browser_upload` 且 `paths` 为空数组取消 chooser（固定 CLI 客户端无法表达）；(b) 关闭会话后对未绑定 task 走 seed 重建路径。

## 2. 根因与共同根因

- 直接根因：draft 阶段恢复依赖页面内工具命令，而固定 CLI 在 modal state 下拒绝全部 tab 工具，`upload` 又无法表达取消语义；恢复合同没有“页面内清理无法证明安全时关闭同名 session、从 seed 重建”的退路。
- 与 `2026-08-08-collab-send-protocol-envelope-failure.md` 的共同根因：两案都发生在 send draft 阶段（提交放行前），浏览器层恢复通道不可用时，原 task 没有可由宿主直接执行且可验证安全状态的恢复或收口路径，均违反 BEH-003“提交前中断恢复为可安全发送的相同 composer”。不同入口：该 Issue 是上传准备或清理结果缺少 protocol envelope（任务已 `failed`、`nextAction` 为 `none`）；本 Issue 是挂起 file chooser 的 modal state 阻塞清理工具（任务保持 `sending`、`nextAction` 恒为 `recover`）。
- 边界（VER-003 已证明）：残留仅附件 chip（无 chooser）的中断点 `recover` 成功；P1 仅限定在“残留挂起 file chooser”子状态。chooser 悬挂与 modal guard 行为以固定 `@playwright/cli@0.1.17` 为界，不做跨版本推断。

## 3. 影响

- 提交前中断且残留挂起 file chooser 时自动恢复失败，任务卡死且无人工裁决入口。
- 宿主不能仅凭返回值证明 composer 已恢复安全；盲目重发可能带入残留附件或重复提交风险。
- 本次经 `close` + 新 task 重建继续，该绕行不证明原 task 的恢复合同完整。

## 4. 目标修复

- 恢复合同补充 clean-or-rebuild 退路：先尝试页面内清理；被挂起 file chooser（modal state）阻塞、无法证明安全时，关闭同名 session 并从 seed 重建——已绑定 conversation 的任务恢复精确 canonical conversation，未绑定任务恢复固定 Project 空白 composer；重建后验证安全，把原 turn 置为 `failed`，返回 `nextAction: send`；绝不自动重发。
- 可行性依据（已核验外部契约）：`close` 是 session 命令、不经过 tab tool modal guard，实机已证明 `close` 成功；重建沿用既有“browser session 不存在时从 seed 重建”的身份约束（同一 `taskId`、同一 session name、固定 Project 与已记录 canonical identity）。
- 本修复不预设 protocol-envelope Issue 的待裁决结果；两案可共享同一兜底合同，但各自完成条件独立。

## 5. 修复前验证条件

- [ ] 确定性夹具复现：自然 kill 后 orphan gate 打开 file chooser、`run-code`/`reload` 被 modal guard 拒绝、`upload` 无法表达取消。
- [ ] 已绑定 conversation 的 task：关闭重建后恢复到精确 canonical conversation 的安全 composer，原 turn 置为 `failed`，无 user turn、无自动发送。
- [ ] 未绑定 conversation 的 task：关闭重建后恢复到固定 Project 空白 composer，原 turn 置为 `failed`，无 user turn、无自动发送。
- [ ] 页面内清理路径仍优先，两种路径都返回经页面验证的安全 composer 证据。
- [ ] 重试不保留残留附件、不残留挂起 chooser、不重复提交 user turn，也不伪造本地完成状态。
- [ ] 实机复验一次自然 kill 后的 chooser 悬挂与关闭重建恢复，取得与 VER-003 相同的证据类型。

完成条件：恢复合同按 clean-or-rebuild 落到 Spec 并经实机复验后，使用确定性夹具覆盖上述每个分支。
