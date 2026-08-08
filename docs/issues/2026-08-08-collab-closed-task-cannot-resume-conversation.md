# Collab 关闭任务后无法继续原 conversation

本文件记录 `chatgpt-pro-collab` 把 `close(taskId)` 作为不可恢复终态，导致宿主在后续用户反馈到达时无法继续同一 ChatGPT Pro conversation 的问题。本记录承载已观察行为、影响和目标合同，不预设具体代码结构。

## 1. 事件事实

- 日期：2026-08-08。
- 已建立 conversation 和 turn 的 task 执行 `close(taskId)` 后，浏览器 session 被终止，task 状态持久化为 `closed`。
- `status(taskId)` 对 `closed` task 返回 `nextAction: none`；`recover(taskId)` 不重建 browser；同一 `taskId` 再次执行 `start` 返回 `TASK_CONFLICT`。
- transcript、canonical conversation identity 与 Web conversation 仍然存在，但 Collab 没有公开路径把该 task 恢复为 active，因此宿主只能创建新 task 和新 conversation。
- 若关闭发生在 `pending` turn 的等待窗口之间，原 `wait` 返回 `TASK_NOT_ACTIVE`，closed task 同样没有恢复入口。
- 另有路由缺口：active task 的 `pending` 或 `capturing` turn 遇到 browser session 缺失时，`status` 先返回 `nextAction: wait`；但 `wait` 不重建 session，只有绕过该指引直接调用 `recover` 才能恢复。

## 2. 根因

- `closed` 被同时用作“浏览器资源已释放”和“task 永久终结”，把本地进程生命周期与 conversation 协作生命周期错误绑定。
- `computeNextAction` 在 browser 缺失判断之前优先返回 `wait`，使已经具备的 pending-turn 重建能力无法通过唯一安全动作暴露。
- 当前恢复实现已经能够从共享 seed 重建同一 named session，并按已记录 canonical URL 验证原 conversation；缺失的是 closed → active 的受证据约束状态转换和正确路由。

## 3. 影响

- Agent 判断任务完成并关闭 browser 后，用户追加 feedback 时无法让 Pro 保留既有上下文继续复审或协作。
- 新建 Pro conversation 必须重新传递背景，容易遗漏此前判断、假设、findings 和确认结果。
- pending 回复可能仍在 Web 端生成，但本地 task 已关闭，Collab 无法继续捕获该 turn。

## 4. 目标修复

采用最小状态语义，不新增命令或状态：

1. `close` 仍以 `closing → closed` 幂等终止本地 browser；`closed` 改为可恢复暂停态，不归档或删除 Web conversation。
2. `status` 对 `closed` task 返回 `nextAction: recover`；同一 `taskId` 的 `start` 仍冲突，避免误建新 conversation。
3. `recover` 从共享 seed 重建同名 session；已绑定 task 只打开并验证记录的 canonical conversation，未绑定 task 只恢复固定 Project 的空白 composer。验证完成后才把 task 重新置为 `active`。
4. closed task 存在 `pending` 或 `capturing` turn 时，恢复后返回 `nextAction: wait`；completed turn 恢复后允许后续显式 `send`，保留同一 conversation 上下文。
5. active task 的 browser 缺失优先返回 `nextAction: recover`；恢复完成后再按 turn 状态返回 `wait` 或 `none`。
6. 重建或 identity 验证失败时保持 `closed`，允许后续再次显式 `recover`；不自动发送、迁移或新建 conversation。

## 5. 修复前验证条件

- [ ] 已完成 turn 的 task：`close → status → recover → send/wait` 使用同一 conversation identity，第二轮回复能使用第一轮上下文。
- [ ] pending/capturing turn 的 task：关闭或 browser 缺失时 `status.nextAction` 为 `recover`，恢复后为 `wait`，原 turn 可继续捕获。
- [ ] 未绑定 conversation 的 closed task：恢复到同一 task 的固定 Project 空白 composer，不创建第二个 task 或 conversation。
- [ ] closed task 的并发 recover 只建立一个有效 named session；验证失败时保持 closed 且 transcript 不变。
- [ ] `closing` 中断仍只能继续 `close`；重复 close 与重复 recover 不产生额外副作用。
- [ ] Web conversation、turn identity、prompt、response、artifact 与共享 seed 在关闭和恢复前后保持绑定。
- [ ] 实机完成一次“首轮完成 → close → recover → feedback → 次轮完成”的连续 conversation 验证。

完成条件：closed task 能在不迁移、不自动重发且不丢失 transcript 的前提下恢复原 conversation，并由确定性测试与一次真实 Web 连续轮次共同证明。
