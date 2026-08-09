# Collab 无法捕获服务端已完成但页面陈旧的 response

本文件记录 `chatgpt-pro-collab` 在 ChatGPT 服务端 response 已完成、但 Web 客户端停留在不可捕获状态时无法自动继续的事件。该状态下普通 DOM 信号无法把它与“仍在生成”区分，reload 重新水合后才能捕获；它与已明确失败或终止的 response 不同，后者只能由宿主按 BEH-013 显式裁决。本记录只承载已观察事实、根因和待验证的修复边界，不预设实现。

## 1. 事件事实

- 日期：2026-08-09。
- 用户报告：长生成 turn 中 ChatGPT 服务端已有 response，但 Web 客户端未呈现可捕获完成控件，普通 DOM 信号无法可靠区分该状态与“仍在生成”。
- 人工 reload 页面后 conversation 重新水合：同一 canonical conversation 与目标 user turn 仍可定位，回复可正常进入既有捕获路径。
- 与已明确失败或终止的 response 的边界：后者 reload 后仍未恢复生成（`2026-08-09-collab-terminal-pro-response-cannot-continue.md`），需要用户提供终端失败事实后由 `resolve-turn ... failed` 裁决；本场景远端已完成，只需重新水合页面即可继续捕获，不应判为失败。

## 2. 根因与共同根因

- 直接根因：完成检测只依赖页面 DOM 组合（Copy 可见、`Stop answering` 消失、稳定检查）。Web 客户端与服务端状态失同步时，任何 DOM 组合都与“尚未完成”无法区分，`wait` 只能观察到窗口到期返回 `pending`，没有自动重新水合路径。
- 既有合同把 reload 当作需要避免的推断性动作，未提供只依赖单调时间、不改变 turn 状态的安全再水合机制。
- 与 `2026-08-09-collab-terminal-pro-response-cannot-continue.md` 的共同边界：两者都不能由时间、reload 或内容稳定自动把 turn 判为 failed；区别在于本场景远端已完成、reload 后可捕获，该场景远端已失败或终止、只能由用户裁决后显式 continuation。

## 3. 影响

- 陈旧页面让 `wait` 反复观察到期返回 `pending`，唯一 unfinished turn 长时间无法捕获，宿主重复等待消耗轮次。
- 无法自动区分“重新水合后仍可完成”与“已明确失败”，宿主 Agent 只能凭猜测干预，破坏一次 wait 一个终态结果的合同。
- 不修复时该状态依赖人工刷新才能继续，自动化协作被中断。

## 4. 目标修复

采用只依赖单调时间的周期 reload，不新增状态、不自动失败、不发送消息：

1. pending turn 的同一次 `wait` 内，未捕获持续每达到 `300000ms` 就无条件 reload 当前已绑定的 canonical conversation；触发只依赖单调时间，不检查 Copy、`Stop answering`、Submit、文本或其他 DOM 完成/卡死信号。
2. reload 耗时计入原 `observationWindowMs`，只在剩余预算内继续；窗口到期仍正常返回 `pending`，期间可按同一周期重复。
3. 每次 reload 后核对同一 canonical conversation 与目标 user turn，再走既有 observation/capture 路径；核对失败时保持 `pending`，不捕获、不自动失败。
4. 不点击 Stop、不改变 turn 状态、不自动失败、不发送 continuation；capturing 恢复与 `resolve-turn ... failed` 合同不变。

## 5. 修复前验证条件

- [ ] 确定性夹具：模拟 stale 完成状态（服务端已有 response、页面未呈现可捕获完成控件），未捕获持续达到 `300000ms` 时按单调时间触发 reload，并经周期 reload 恢复既有观察与捕获。
- [ ] reload 后同一 canonical conversation 与目标 user turn 核对成功，继续既有观察与捕获并完成。
- [ ] reload 后身份核对失败时保持 `pending`，不捕获、不自动失败。
- [ ] reload 耗时计入 `observationWindowMs`，剩余预算耗尽时窗口到期正常返回 `pending`；同一次 wait 内多次 reload 周期可重复。
- [ ] reload 期间不点击 Stop、不改变 turn 持久状态、不发送 continuation；turn 持久状态与审计不变。
- [ ] capturing 恢复与 `resolve-turn ... failed` 行为与既有合同一致。
- [ ] 实机 live：让一个长生成 turn 跨过 `300000ms` 自动 reload 点，证明 reload 不终止远端生成、同一 canonical conversation 与目标 user turn 身份不变、最终完成捕获且无额外 user turn；自然偶发 stale 的再次实机复现列为证明边界，不作为必测前置。

完成条件：陈旧但服务端已完成的 pending turn 能在同一次 wait 内由单调时间驱动的周期 reload 自动重新水合，走既有观察/捕获路径完成，不引入 Stop 点击、自动失败或 continuation。
