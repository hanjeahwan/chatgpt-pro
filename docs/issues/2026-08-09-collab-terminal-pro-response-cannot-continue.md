# Collab 无法裁决已明确失败的 Pro response

本文件记录 `chatgpt-pro-collab` 在消息已提交、但 ChatGPT Pro response 已明确失败或终止时仍把 turn 保持为 `pending`，导致宿主无法在原 conversation 显式发送 continuation 的问题。本记录区分用户提供的失败事实、当前本地合同与待实现行为，不把观察超时推断为远端失败。

## 1. 事件事实

- 日期：2026-08-09。
- 用户报告：目标 Pro turn 已明确失败或终止，reload 后仍未恢复生成。
- 当前合同只把已提交但未完整捕获的 turn 表示为 `pending`；`status` 返回 `nextAction: wait`，同一 task 的新 `send` 被 `TURN_IN_PROGRESS` 拒绝。
- 当前只有 `resolve-submission` 能裁决“消息是否提交”，没有入口裁决“消息已提交，但 response 已明确失败或终止”。
- 直接在 Web composer 手工发送“继续”会建立 Collab 未记录的新 user turn，使本地 transcript、下一轮锚点与 Web conversation 漂移。

## 2. 根因

- `pending` 正确地不推断 Pro 仍在生成，但缺少用户提供终端失败事实后的显式退出路径。
- `wait` 只负责观察和捕获，不应根据时间、内容稳定或 reload 结果自动把 response 判为失败。
- submission 裁决发生在提交边界，不能复用来表示已经提交后的 response 失败。

## 3. 影响

- 已明确失败的 response 会永久占用 task 的唯一 unfinished turn，后续显式 feedback 无法发送。
- 创建新 task 会丢失原 conversation 上下文；手工修改数据库或直接操作 Web 会破坏审计和 turn identity。
- 自动发送“继续”可能与迟到的原 response 并发，产生重复或错误锚定的回复。

## 4. 目标修复

采用一个显式裁决命令，不新增状态或自动重试层：

1. 新增 `resolve-turn <taskId> <turnId> failed`；只有用户明确确认该 Pro response 已失败或终止时，宿主才执行，不能从 repeated `pending`、超时或内容稳定自动推断。
2. 命令只接受 active、已绑定 canonical conversation 的 `pending` turn；`capturing` 必须继续 `wait`，其他 turn 状态返回冲突。browser 缺失时先按既有身份合同重建原 conversation。
3. 页面验证同一 canonical conversation、唯一目标 user turn、其后没有新 user turn及可继续使用的 composer。若仍有可见的精确 `Stop answering`，该显式裁决只点击一次并等待它消失；验证失败时 turn 保持 `pending`。
4. 页面安全后把原 turn 原子置为 `failed`，在 error 审计中记录 human adjudication、页面身份与是否执行 Stop；返回 `nextAction: send`。
5. 重复同一裁决幂等返回，不创建 user turn；并发裁决通过既有 task lease 串行化。
6. 裁决本身不发送“继续”。宿主另行显式 `send` 一条说明从上一轮中断处继续、避免重复已有内容的具体 prompt，再按普通 `wait` 捕获新 turn。

## 5. 修复前验证条件

- [ ] `pending` turn 在用户未明确提供失败事实时仍只能 `wait`，不会因时间或 reload 自动失败。
- [ ] `resolve-turn ... failed` 在 Stop 不可见时验证同一 conversation、目标 user turn、无后续 user turn和安全 composer，再把 turn 置为 failed。
- [ ] Stop 可见时只点击一次；点击或安全 composer 验证失败时保持 pending，且没有 continuation user turn。
- [ ] browser 缺失时重建同一 named session 与 canonical conversation 后再裁决，不迁移 conversation。
- [ ] capturing、completed、sending、unknown-submission、错误 task/turn 和页面漂移均被拒绝。
- [ ] 重复和并发裁决不产生额外页面动作；成功后显式 continuation `send/wait` 使用同一 conversation，旧 turn 为 failed，新 turn 独立完成。
- [ ] 实机完成一次“提交长回复 → 显式 failed 裁决/终止 → 显式 continuation → 新 turn 完成”，Web 端只有预期两条 user message。

完成条件：宿主能在用户明确确认 Pro response 失败或终止后，安全结束旧 pending turn，并在不自动发送、不迁移 conversation 和不破坏审计的前提下显式继续协作。
