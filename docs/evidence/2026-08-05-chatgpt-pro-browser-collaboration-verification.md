# ChatGPT Pro Browser Collaboration 实现验证记录

本文记录 2026-08-05 对 `docs/specs/2026-08-03-chatgpt-pro-browser-collaboration.md` 的实现、确定性检查和 live ChatGPT Web 取证结果。证据按规格原始通过条件判定；局部成功、自动化测试或复用既有认证状态不会被写成完整 live 通过。

## 1. 实现基线与范围

- 工作树：`/Users/codeartz/orca/workspaces/chatgpt-pro/chatgpt-pro-collab-implementation`
- 分支：`hanjeahwan/chatgpt-pro-collab-implementation`
- Spec 与任务账本基线：`83577dba613e7a25790bcfcc1e660a936483abd7`
- 最后一个产品实现提交：`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`
- 范围：依照 `dependsOn` 完成 IMP-001 至 IMP-008；首次 Review Task `task_f83d3a0d427b` 已提出五项 finding，当前记录修复与证据状态，关闭结论仍由原 reviewer terminal 复审。

## 2. IMP、行为、验证与提交

| IMP     | 覆盖 BEH                                    | 对应 VER                           | 实现提交                                                                                                                                                                       |
| ------- | ------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IMP-001 | BEH-001、BEH-002                            | VER-001、VER-002                   | `c7f25abec5d02053a251f2befd395dc0ebdd734a`                                                                                                                                     |
| IMP-002 | BEH-007                                     | —                                  | `2d81754353357ab76124654c452cfc6da914e034`                                                                                                                                     |
| IMP-003 | BEH-003、BEH-010                            | VER-003、VER-013                   | `7dfe15aa2afec0a1fa11c218fcdb48ed56e3b052`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`                                                                                         |
| IMP-004 | BEH-004、BEH-011                            | VER-004、VER-014                   | `8f10d2c8aca3bd123594071bd7a945ae9972c948`                                                                                                                                     |
| IMP-005 | BEH-012                                     | VER-015                            | `7a42428d9bf07e7f9fb65c0c71b6133ff322e46d`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`、`8da196df7980244387c343827e36e6f29f001f4f`、`98e45139ee76b4b7c254988692f6f1b4ba3e761e` |
| IMP-006 | BEH-005、BEH-006                            | VER-005、VER-006                   | `14d154c2cc7c66fa73da2c37f1e2570624021a60`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`                                                                                         |
| IMP-007 | BEH-008、BEH-009                            | VER-008、VER-009                   | `0d2a857b91bf1a3a575f4e5b859f15aa5c56149f`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`                                                                                         |
| IMP-008 | BEH-002、BEH-004、BEH-006、BEH-007、BEH-012 | VER-007、VER-010、VER-011、VER-012 | `0070235444624d30daeb38f232fe47c08707c04b`、`ff87186162b8558e40af013aac4d81826c345ca7`                                                                                         |

`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76` 是 live forward test 后的最小修复：等待附件菜单水合、归档 conversation 在下一次发送前显式恢复、按稳定 DOM 标记映射返回文件，并校验浏览器建议文件名与逻辑 sandbox 目标一致。

`56d21d9ed42694659bce992b7bf88ed33ad37014` 修复 F3：任务新增 `implemented` 状态，实施依赖只要求前置任务已实施，`done` 与最终交付仍要求 Review 证据；仓库 Skill、WORKFLOW 与任务账本同步采用新合同，不保留旧格式兼容。

## 3. Live 取证事实

- 两个任务使用不同 named session、taskId、session 目录和 conversation ID；复制后的共享 seed SHA-256 均为 `3e4b106c38bf33013d364cc2e0c16711e04cba0c486de8531747f96680aba352`，执行后未变化。此次没有重新执行交互式 setup 登录。
- Task A 首轮只上传显式选择的工作区内外普通文件，回复保留标题、TypeScript fenced code block 和原始文本；第二轮在同一 conversation 引用首轮 marker，并生成仅含 `selected-one.txt` 与 `nested/selected-two.txt` 的 `selected-inputs.tar.gz`。
- Task A 与 Task B 的生成区间在 `17:50:18Z` 至 `17:50:43Z` 重叠；本地 task、session、conversation、turn 与 transcript 归属互不混淆。
- 返回文件用例捕获六个唯一 sandbox 目标：HTML、ZIP、PNG、Python 源码和两个同名文本文件。重复 HTML 目标被去重，普通 HTTPS 链接未下载；最终落盘为六个不同路径，两个同名目标分别位于独立 ordinal 目录。
- 已归档 conversation `6a72265c-a564-83ec-9f20-b1f6ed427639` 在后续浏览器发送时被显式 Unarchive，发送、等待与捕获继续使用相同 canonical conversation ID。该证明来自专用恢复会话，不是一次从创建、归档到恢复均由同一本地 task 完成的完整 VER-009 流程。
- `close` 对活动浏览器会话返回 `wasOpen=true`，第二次调用返回 `wasOpen=false`、`alreadyClosed=true`，没有重新打开浏览器。

## 4. VER-001 至 VER-015 判定

| VER     | 判定      | 已取得证据与缺口                                                                                                                                                                                                                                                         |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VER-001 | ❌ 未取得 | 协调员决定不重复交互式登录；既有 seed 的复用和哈希不变不能替代“干净认证目录 → setup 登录 → state-save → 关闭 setup”的 fresh setup 证据。                                                                                                                                 |
| VER-002 | ⚠️ 部分   | 两个任务的 named session、taskId、session 路径和 conversation 均不同且完成首次发送，但 VER-001 前置未通过，且本轮没有形成可持久复核的不同浏览器 PID 与内存 browser context 证据，因此不能判定通过。                                                                      |
| VER-003 | ✅ 通过   | 自动化文件访问边界与 live Web 上传共同证明只读取和上传显式 prompt/附件，允许工作区外显式普通文件，未上传未选择项，并返回 turnId。                                                                                                                                        |
| VER-004 | ⚠️ 部分   | live `response.md` 保留标题、代码块和原始文字，返回文件为空；自动化覆盖 Copy response、重复 wait 和不覆盖旧文件，但本轮 live 记录不足以逐项重放“逐字节比较 + 重复 wait”，故不判定完整 live 通过。                                                                        |
| VER-005 | ✅ 通过   | 同一 Task A 的第二轮保持 conversation ID，正确引用首轮 marker，两个 turn 目录独立。                                                                                                                                                                                      |
| VER-006 | ⚠️ 部分   | 两个生成区间有 25 秒重叠，task/session/conversation/transcript 隔离；另一次单边远端长时间 pending 时另一任务仍完成，但 VER-002 前置未通过，不能判定完整通过。                                                                                                            |
| VER-007 | ⚠️ 部分   | SQLite、turn 目录、同名 artifact ordinal、关闭后复读和恢复矩阵有自动化覆盖；未取得严格要求的完整 live 流程，包括修改已发送 prompt 后用新 CLI 进程复读全部证据。                                                                                                          |
| VER-008 | ⚠️ 部分   | live 两次 close 证明幂等且未重新打开浏览器；本轮没有把“Web 未归档、浏览器 PID 消失、全部本地证据与 seed 保留”汇成同一可复核检查集，故不判定完整通过。                                                                                                                    |
| VER-009 | ⚠️ 部分   | live archive 成功；最终实现也在专用会话中对同一 canonical ID 完成显式 Unarchive、send 与 wait。专用全链路复验受 ChatGPT 远端生成持续 pending 阻塞，未取得同一本地 task 从 archive 到恢复再到后续 turn 的完整证据。                                                       |
| VER-010 | ✅ 通过   | 最后相关实现提交后运行格式、lint、类型、全量测试、CLI help、无宿主 `package.json` 的绝对路径 help；入口和两个 wait 时长参数均检查通过。                                                                                                                                  |
| VER-011 | ❌ 未通过 | 新增真实子进程 SIGKILL/reopen，已覆盖稳定 capturing 集、response 发布、artifact 发布未更新状态、部分 artifact 完成及并发 close；但 F1 原子冻结合同尚待产品裁决与修复，因此仍不判定通过。                                                                                 |
| VER-012 | ✅ 通过   | 最低 Node v22.19.0 与当前 Node 的版本、`node:sqlite`、最小 TypeScript 入口 smoke test，以及固定 Playwright CLI help 均退出 0。                                                                                                                                           |
| VER-013 | ❌ 未取得 | live 仅验证了两个已选文件的 `.tar.gz` 解压内容；没有运行两个宿主 Agent、至少 100 个代码文件、xattr 核对以及跨平台提示触发 `.zip` 的完整 forward test。                                                                                                                   |
| VER-014 | ❌ 未取得 | 自动化测试覆盖终态与内部多次页面检查，但没有取得宿主 Agent 对四种场景各只调用一次 Skill/CLI wait 的进程、页面检查和 stdout/stderr 证据。规格明确禁止用文案或单元测试替代。                                                                                               |
| VER-015 | ⚠️ 部分   | live 证据仍有效；live-compatible fixture 已实际执行生成的 capture/download function，覆盖 occurrence/button 数量、artifact 行顺序、控件关系、direct/artifact event、超时浏览器错误和 capturing 不变量。F2 watchdog 尚未裁决，不能宣称 `CAPTURE_TIMEOUT` 终态已完整证明。 |

## 5. 最终确定性检查

| 检查                                                                        | 结果                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm format:check`                                                         | ✅ 49 个文件格式通过                                      |
| `pnpm lint`                                                                 | ✅ 退出码 0                                               |
| `pnpm typecheck`                                                            | ✅ 退出码 0                                               |
| `pnpm test`                                                                 | ✅ 8 个 test file、81 个测试通过                          |
| `pnpm exec vitest --run tests/state-concurrency.test.ts`                    | ✅ 9 个真实子进程恢复与并发测试通过                       |
| `pnpm exec vitest --run tests/browser.test.ts`                              | ✅ 25 个浏览器边界与可执行页面 fixture 测试通过           |
| `pnpm collab -- help`                                                       | ✅ 退出码 0；wait usage 含两个独立时长参数                |
| 无 `package.json` 临时目录中用绝对路径执行 `collab.ts help`                 | ✅ 退出码 0                                               |
| Node v25.9.0 与 Node v22.19.0 的 `node:sqlite` 和 TypeScript CLI smoke test | ✅ 两个版本均退出码 0                                     |
| `npx -y @playwright/cli@0.1.17 --help`                                      | ✅ 退出码 0                                               |
| `git diff --check`                                                          | ✅ 退出码 0                                               |
| 任务账本 `spec-tasks diff`                                                  | ✅ Spec/context 无漂移                                    |
| 任务账本 `spec-tasks check --ready`                                         | ✅ 所有实现任务均为 `implemented`，实施依赖与覆盖检查通过 |

`implemented` 只证明实现提交与相关检查已取得，可满足后续实施依赖；它不代表全量 VER 或 Review 已通过，`check --final` 仍应拒绝交付。

## 6. 失败尝试与边界

- 一次并发 live 复验中 Task A 的远端生成超过 300 秒仍为 pending；Task B 仍完成六文件捕获。停止该 runner 并显式关闭两个会话，未把远端未完成写成产品实现失败或验证通过。
- 专用 archive 全链路复验的第一条简单回复超过 120 秒仍未完成，因此没有进入 archive 阶段。继续重试不会引入新假设或证据来源，依照 Spec 停止重复尝试。
- 首次 Review 的 F1/F2 暴露当前 Spec 冲突：line 217 禁止在取得完整 Copy/artifact 描述前进入 `capturing`，BEH-004 与 lines 161/176/233 又要求此前发生 capture timeout 时返回 `CAPTURE_TIMEOUT` 并保持 `capturing`。已通过 orchestration ask 请求产品裁决，收到裁决前不修改 Spec 或相关实现。
- Live 临时根包含认证 seed 副本和下载产物，只用于当次检查；交付前已按核对后的精确路径从 `/private/tmp` 移入系统废纸篓，仍可由系统废纸篓恢复。本报告不依赖这些临时根持续存在。
- 任务账本保持 `implemented` 且 `evidence.reviews` 为空。原因是本 worker 不执行 Code Review，且 VER-001、VER-013、VER-014 以及若干严格 live 证据仍未取得；不得伪造 `done` 或 review 证据。

## 7. 交付前检查

- [x] IMP-001 至 IMP-008 按 `dependsOn` 顺序形成目的单一提交。
- [x] Live 发现的归档恢复和返回文件 DOM 映射问题已最小修复并复验相关路径。
- [x] 账本写入真实 commit、check 和 live 证据，未填入 review 结果。
- [x] 明确区分完整通过、部分证据和未取得证据。
- [ ] VER-001 fresh setup、VER-013 双宿主归档 forward test、VER-014 单次等待宿主调用证据尚未取得。
- [ ] VER-002、VER-004、VER-006、VER-007、VER-008、VER-009 的严格通过条件需要在前置满足后补齐或重跑。
- [ ] F1/F2 产品裁决及原 reviewer terminal 复审尚未完成。

## 8. 最终判断

F3 实施依赖循环已修复，F4/F5 的缺失矩阵已补测；F1/F2 因现行 Spec 条款冲突暂停，相关 VER-011 与 VER-015 不能恢复为通过。当前证据不满足最终验收条件，任务账本必须继续保持 `implemented`，等待产品裁决与原 reviewer 复审。
