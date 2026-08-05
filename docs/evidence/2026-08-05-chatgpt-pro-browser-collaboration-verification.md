# ChatGPT Pro Browser Collaboration 实现验证记录

本文记录 2026-08-05 对 `docs/specs/2026-08-03-chatgpt-pro-browser-collaboration.md` 的实现、确定性检查和 live ChatGPT Web 取证结果。证据按规格原始通过条件判定；局部成功、自动化测试或复用既有认证状态不会被写成完整 live 通过。

## 1. 实现基线与范围

- 工作树：`/Users/codeartz/orca/workspaces/chatgpt-pro/chatgpt-pro-collab-implementation`
- 分支：`hanjeahwan/chatgpt-pro-collab-implementation`
- Spec 原子捕获边界裁决提交：`9b7c5881b8f4b0ac3a51c67671bdc3dd1b88a5ba`
- 首次增量账本对账提交：`713772dc377ef53cb27831a2fc05540873d99a45`
- 最后一个产品实现提交：`0ccb41a432f0608cbf0bfba5a4c20fa964ac4ebc`
- 范围：依照 `dependsOn` 完成 IMP-001 至 IMP-008。根 Review Task `task_f83d3a0d427b` 的 F1–F5 已由同一 reviewer conversation `019fcdfa-ef5f-7410-a245-6bbaf7be52dd` 全部关闭；独立 Review `task_1775af5d8e88` 已接受 confirmed-pending 诊断修复。独立 reviewer thread `task_d8758885857a` 对 repeated-close 初次修复发现一个 P1；`0ccb41a` 已修复并复验，等待同一 reviewer conversation `term_1f28048f-d0f0-44b1-92f0-18251e33850c` 复审。

## 2. IMP、行为、验证与提交

| IMP     | 覆盖 BEH                                    | 对应 VER                           | 实现提交                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMP-001 | BEH-001、BEH-002                            | VER-001、VER-002                   | `c7f25abec5d02053a251f2befd395dc0ebdd734a`                                                                                                                                                                                                                             |
| IMP-002 | BEH-007                                     | —                                  | `2d81754353357ab76124654c452cfc6da914e034`                                                                                                                                                                                                                             |
| IMP-003 | BEH-003、BEH-010                            | VER-003、VER-013                   | `7dfe15aa2afec0a1fa11c218fcdb48ed56e3b052`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`                                                                                                                                                                                 |
| IMP-004 | BEH-004、BEH-011                            | VER-004、VER-014                   | `8f10d2c8aca3bd123594071bd7a945ae9972c948`、`fe6c221706fbfe9a87844b064038927e0fcaf029`、`ba09c01c6c8d7d343fc3108655047c923da2a8c5`、`7255f52a0f39a96f332a12f8ece34ed1890217e8`                                                                                         |
| IMP-005 | BEH-012                                     | VER-015                            | `7a42428d9bf07e7f9fb65c0c71b6133ff322e46d`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`、`8da196df7980244387c343827e36e6f29f001f4f`、`98e4513e14f3d7415fd4e75ea37fad01093f20d4`、`fe6c221706fbfe9a87844b064038927e0fcaf029`、`ba09c01c6c8d7d343fc3108655047c923da2a8c5` |
| IMP-006 | BEH-005、BEH-006                            | VER-005、VER-006                   | `14d154c2cc7c66fa73da2c37f1e2570624021a60`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`、`ba09c01c6c8d7d343fc3108655047c923da2a8c5`                                                                                                                                     |
| IMP-007 | BEH-008、BEH-009                            | VER-008、VER-009                   | `0d2a857b91bf1a3a575f4e5b859f15aa5c56149f`、`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76`、`18b91f1435c1582d1f7f83e48297b08be56cb8b3`、`0ccb41a432f0608cbf0bfba5a4c20fa964ac4ebc`                                                                                         |
| IMP-008 | BEH-002、BEH-004、BEH-006、BEH-007、BEH-012 | VER-007、VER-010、VER-011、VER-012 | `0070235444624d30daeb38f232fe47c08707c04b`、`ff87186162b8558e40af013aac4d81826c345ca7`、`fe6c221706fbfe9a87844b064038927e0fcaf029`、`ba09c01c6c8d7d343fc3108655047c923da2a8c5`、`7255f52a0f39a96f332a12f8ece34ed1890217e8`                                             |

`08e1a38c050011f0dbd362e56b7b88d5b2cb3c76` 是 live forward test 后的最小修复：等待附件菜单水合、归档 conversation 在下一次发送前显式恢复、按稳定 DOM 标记映射返回文件，并校验浏览器建议文件名与逻辑 sandbox 目标一致。

`56d21d9ed42694659bce992b7bf88ed33ad37014` 修复 F3：任务新增 `implemented` 状态，实施依赖只要求前置任务已实施，`done` 与最终交付仍要求 Review 证据；仓库 Skill、WORKFLOW 与任务账本同步采用新合同，不保留旧格式兼容。

`fe6c221706fbfe9a87844b064038927e0fcaf029` 修复 F1 及 F2 的 response capture 路径：删除观察完成后的过早 `beginCapture`，以单个 `BEGIN IMMEDIATE` 事务冻结 `pending → capturing`、`response_path` 与全部 artifact 行；宿主单调 watchdog 通过 AbortSignal 安全终止 response capture 的 page command 及 gate。复审随后证明 post-freeze `downloadArtifact` 尚未进入同一 watchdog，F2 与 VER-015 因此重新打开。

`ba09c01c6c8d7d343fc3108655047c923da2a8c5` 完成 F2 剩余实现：`captureResponse` 与每个 `downloadArtifact` 复用同一绝对单调 deadline；AbortSignal 从服务穿透 Playwright page command、gate 与实际子进程。deadline 前下载错误保留原码；deadline 后即使 provider 忽略取消或永不 settle，服务也在有限清理宽限后返回 `CAPTURE_TIMEOUT`、保持 `capturing` 并释放 operation lease，重试只处理剩余 artifact。

`18b91f1435c1582d1f7f83e48297b08be56cb8b3` 首次修复 VER-008 live 发现的 repeated-close 副作用；独立 Review `task_d8758885857a` 随后发现事务外 closed 快速读取与 lease 获取之间仍有跨连接 P1。`0ccb41a432f0608cbf0bfba5a4c20fa964ac4ebc` 把 closed 判定与 close lease 获取合并到同一 `BEGIN IMMEDIATE` 状态门，已 closed 分支不写 lease 或 `updated_at`，并保留顺序重复 close 测试、增加两连接确定性交错回归。`7255f52a0f39a96f332a12f8ece34ed1890217e8` 修复 confirmed submission 进入 `pending` 后保留陈旧 `error` 的问题，已由独立 Review `task_1775af5d8e88` 接受且无 P1/P2/P3 finding。

## 3. Live 取证事实

- 两个任务使用不同 named session、taskId、session 目录和 conversation ID；复制后的共享 seed SHA-256 均为 `3e4b106c38bf33013d364cc2e0c16711e04cba0c486de8531747f96680aba352`，执行后未变化。此次没有重新执行交互式 setup 登录。
- Task A 首轮只上传显式选择的工作区内外普通文件，回复保留标题、TypeScript fenced code block 和原始文本；第二轮在同一 conversation 引用首轮 marker，并生成仅含 `selected-one.txt` 与 `nested/selected-two.txt` 的 `selected-inputs.tar.gz`。
- Task A 与 Task B 的生成区间在 `17:50:18Z` 至 `17:50:43Z` 重叠；本地 task、session、conversation、turn 与 transcript 归属互不混淆。
- 返回文件用例捕获六个唯一 sandbox 目标：HTML、ZIP、PNG、Python 源码和两个同名文本文件。重复 HTML 目标被去重，普通 HTTPS 链接未下载；最终落盘为六个不同路径，两个同名目标分别位于独立 ordinal 目录。
- F1/F2 修复后的独立 live task `9aacd83c-83d4-461f-8cad-e546d45eae98` 在一次 `wait` 中完成 turn `d40fd7bd-7e24-42fe-a1b8-ba0d188bef94`。Copy response 同时包含两次 `sandbox:/mnt/data/page.html`、五个其他唯一 sandbox 目标和 `https://example.com/`；SQLite 只记录六行有序唯一 artifact，`artifact_set_recorded=1`、turn 为 `completed` 且无错误。HTML、ZIP、1×1 PNG、Python 与两个内容不同的同名文本均通过格式或内容核对；第二次 `wait` 返回完全相同的 response/artifact 路径。
- `ba09c01c6c8d7d343fc3108655047c923da2a8c5` 后在当前起始 HEAD `2c18adab58157634ce37f3a75cd1f0015bd757a7` 新建 live task `f44b6453-b56a-471a-8c39-606291de98f2` 与 turn `7567c354-7a47-4674-9cd6-1bff68820f50`。主路径只调用一次 `wait`：`node /Users/codeartz/orca/workspaces/chatgpt-pro/chatgpt-pro-collab-implementation/skills/chatgpt-pro-collab/scripts/collab.ts wait f44b6453-b56a-471a-8c39-606291de98f2 7567c354-7a47-4674-9cd6-1bff68820f50 600000 300000`；该进程内部观察后返回唯一 `completed` JSON，Agent 未另行轮询网页。
- 此次 live Copy response 持久化为 470 字节的 `response.md`，SHA-256 为 `38539261bf7cf124ab26f5b7f55f7ce6521882954adb3a217e3fe1101a054833`。正文按顺序含七次 sandbox occurrence：`page.html` 目标重复两次，其余五个目标各一次；六个唯一目标与 SQLite ordinal 1–6 完全同序，普通 `https://example.com/` 未进入 artifact 表。turn 为 `completed`、`artifact_set_recorded=1`、`error=null`，六行均为 `completed` 且 source URL 唯一。

| ordinal | 唯一 source URL                               | 本地下载名       | 内容或格式核对                                               |
| ------- | --------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| 1       | `sandbox:/mnt/data/post_ba09/page.html`       | `page(13).html`  | 有效 HTML，含 `post-ba09 live evidence`                      |
| 2       | `sandbox:/mnt/data/post_ba09/bundle.zip`      | `bundle(14).zip` | 有效 ZIP，仅含 `inside.txt`，内容为 `post-ba09 zip evidence` |
| 3       | `sandbox:/mnt/data/post_ba09/pixel.png`       | `pixel(13).png`  | PNG 签名正确，1×1 RGB                                        |
| 4       | `sandbox:/mnt/data/post_ba09/solution.py`     | `solution.py`    | 内容为 `print("post-ba09 live evidence")`                    |
| 5       | `sandbox:/mnt/data/post_ba09/first/same.txt`  | `same(4).txt`    | 内容为 `post-ba09 first same-name file`                      |
| 6       | `sandbox:/mnt/data/post_ba09/second/same.txt` | `same(5).txt`    | 内容为 `post-ba09 second same-name file`                     |

- 两个逻辑 source URL 的 basename 与 response label 均为 `same.txt`，本地位于不同 ordinal 目录、inode 与 SHA-256 均不同，没有覆盖。幂等核对命令 `wait f44b6453-b56a-471a-8c39-606291de98f2 7567c354-7a47-4674-9cd6-1bff68820f50 1 1` 返回完全相同的 `responsePath` 和六个 `artifactPaths`；随后 `close` 返回 `wasOpen=true`，task 变为 `closed` 且 operation 字段为空。临时宿主 prompt 已删除，task transcript 内的 `prompt.md` 保留；认证 seed SHA-256 仍为 `3e4b106c38bf33013d364cc2e0c16711e04cba0c486de8531747f96680aba352`。
- 已归档 conversation `6a72265c-a564-83ec-9f20-b1f6ed427639` 在后续浏览器发送时被显式 Unarchive，发送、等待与捕获继续使用相同 canonical conversation ID。该证明来自专用恢复会话，不是一次从创建、归档到恢复均由同一本地 task 完成的完整 VER-009 流程。
- `close` 对活动浏览器会话返回 `wasOpen=true`，第二次调用返回 `wasOpen=false`、`alreadyClosed=true`，没有重新打开浏览器。
- VER-004 使用 task `a07ea1df-5f57-43b8-961a-5acaebb65c70`、turn `9fe0a34a-4f4e-48fa-8c1e-0396a59ae446` 和一次 `wait 600000 300000` 取得 completed。生成的 `capture-response-a08c67b6-5002-47ac-88c7-0b76fdc1f705.js` 在目标 assistant 内确认 Stop 不可见、Copy 唯一可见，并用页面内 `navigator.clipboard.write/writeText` 拦截取得 Copy response；未读取 OS clipboard。Copy 的 4,121 字节与 `response.md` 逐字节相同，SHA-256 为 `62494e1f396c1de8c4477a467663a53921d33e1b06981e22cc9b316ddbd8a54a`，正文含长文本、TypeScript 围栏和三个唯一 marker，artifact 表与 `artifactPaths` 均为空；重复 `wait 1 1` 返回同一路径，inode、mtime、字节与哈希均未变化。
- VER-007 使用 task `fc4bad58-0475-4725-9e03-662255b55adb` 的 turns `0af0b2c4-88ec-43ae-8a26-bf6322330720`、`1daef080-027a-473c-be60-f19edbe4958a`。两次 send 使用同一宿主 `/private/tmp/ver007/prompt.md`、同一附件路径和同名返回文件 `same-result.txt`；turn 内 prompt 副本哈希分别为 `b88ce324...`、`e938f49d...`，两个 artifact 位于各自 turn/ordinal 目录。宿主随后改写 prompt 与附件；关闭后新的 CLI 进程仍复读相同 response/artifact 路径、inode、mtime 和哈希，session 内对附件原正文 marker 的全文件扫描为 0 命中。
- VER-008 的首次 live task 暴露第二次 `close` 会经 operation lease 改写 `task.updated_at`；`18b91f1` 修复顺序调用，但 reviewer `task_d8758885857a` 证明两连接交错仍可在外部预读后改写 closed task。`0ccb41a` 改为原子状态门后，再对既有已关闭 task `72a8d8dc-80ae-4821-b478-745a5d2701d8` 调用 `close`，返回 `wasOpen=false/alreadyClosed=true`；包含 conversation、状态、`updated_at=2026-08-05T03:32:26.787Z`、`closed_at=2026-08-05T03:32:26.786Z` 和全部 null lease 字段的完整 task 行前后逐字相同，seed SHA-256 仍为 `3e4b106c38bf33013d364cc2e0c16711e04cba0c486de8531747f96680aba352`。此前同一 task 已证明 browser PID `59559`、named session 消失，本地证据与 Web conversation 保留。
- VER-009 使用同一 task `72a8d8dc-80ae-4821-b478-745a5d2701d8`、conversation `6a72ae36-1a58-83ec-9cc8-4d7154d7fe00` 和 PID `59559`。原 turn `3bdd920c-5a46-4709-9199-02f2ac483c3c` 完成后，`archive` 返回原 ID；随后页面恢复原 canonical URL、原两个 turn 可定位，目标侧栏计数从 1 变为 0，两个对照 conversation 仍各为 1。后续 turn `9476aa64-4061-4464-a282-9a745d7f83b5` 在同一 task send/wait，显式引用原 marker、返回可读 artifact，目标侧栏恢复为 1；conversation、PID、原 response 哈希和 transcript 均保持。
- VER-013 的两个独立宿主 Agent 都完成了格式自主选择和本地归档边界。Agent A `task_c4fbc6efab2a` 未收到格式提示，选择 `.tar.gz`，用 `COPYFILE_DISABLE=1 tar --no-xattrs --no-recursion` 归档 100 个明确 regular `.ts` 文件；Agent B `task_823bbdaa4c97` 只收到“接收端不能假定有 tar”的跨平台约束，自主选择 `zip -X`。两者都证明 100/100 marker、源端 100/100 xattr、归档无 xattr/AppleDouble/额外文件、本地解压逐文件一致、send 只传一个归档且 Web 只有一个上传项；但唯一有限 wait 分别在 live tasks `e5f2f859-9d85-4259-95fc-cf3cf83c0bc5`、`4088b600-e555-41f2-87ba-173ef2ad0608` 返回 pending，因此没有 Pro 侧解压数量、marker 与摘要，VER-013 仍未通过且未擅自重跑。
- VER-014 独立宿主 Agent `task_8c09b3657e50` 通过真实 Skill+CLI 可控 fixture 完成四场景：completed、pending、`CAPTURE_TIMEOUT`、`BROWSER_COMMAND_FAILED` 的宿主 wait 均为 1、另行浏览器轮询为 0，页面检查数分别为 8、3、6、0；每场景终态前 stdout/stderr 为 0 字节，结束只有一个终态 JSON，真实 CLI/gate/guarded-command PID 均在退出后消失。完整证据为 status `msg_e39e894f1103` 和 `/private/tmp/ver014-agent-c/report.md`。后续 `7255f52` 只改变 confirmed-pending 的诊断清理，不影响四种终态；当前 HEAD 的定向 fixture task `be5fa062-8eea-4f74-a9f4-75986e4852ca` 再次执行唯一 `wait 1100 2000`，三次页面检查后返回 pending，SQLite `error=NULL` 且 operation lease 全部清空。

## 4. VER-001 至 VER-015 判定

| VER     | 判定      | 已取得证据与缺口                                                                                                                                                                                                                                       |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VER-001 | ❌ 未取得 | 协调员决定不重复交互式登录；既有 seed 的复用和哈希不变不能替代“干净认证目录 → setup 登录 → state-save → 关闭 setup”的 fresh setup 证据。                                                                                                               |
| VER-002 | ⚠️ 部分   | 两个任务的 named session、taskId、session 路径和 conversation 均不同且完成首次发送，但 VER-001 前置未通过，且本轮没有形成可持久复核的不同浏览器 PID 与内存 browser context 证据，因此不能判定通过。                                                    |
| VER-003 | ✅ 通过   | 自动化文件访问边界与 live Web 上传共同证明只读取和上传显式 prompt/附件，允许工作区外显式普通文件，未上传未选择项，并返回 turnId。                                                                                                                      |
| VER-004 | ✅ 通过   | task `a07ea1df-5f57-43b8-961a-5acaebb65c70` 的唯一主 wait 完成；目标 assistant、Stop/Copy、页面内 clipboard 拦截、Copy 与 response.md 的 4,121 字节相等、空 artifact、重复 wait 路径/文件不变均直接核对。                                              |
| VER-005 | ✅ 通过   | 同一 Task A 的第二轮保持 conversation ID，正确引用首轮 marker，两个 turn 目录独立。                                                                                                                                                                    |
| VER-006 | ⚠️ 部分   | 两个生成区间有 25 秒重叠，task/session/conversation/transcript 隔离；另一次单边远端长时间 pending 时另一任务仍完成，但 VER-002 前置未通过，不能判定完整通过。                                                                                          |
| VER-007 | ✅ 通过   | 两个 completed turn 使用同一宿主 prompt/附件路径和同名返回文件；宿主改写后，关闭任务并由新 CLI/SQLite 进程复读，turn prompt 副本、response、artifact 顺序/路径/字节保持，附件正文 marker 在 session 中 0 命中。                                        |
| VER-008 | ✅ 通过   | live 先发现并修复 repeated close 的 `updated_at` 副作用；修复后同一 task 的 browser PID/named session 消失，SQLite、transcript、artifact、seed 和 Web conversation 均保留，第二次 close 的持久 task 记录逐字段不变。                                   |
| VER-009 | ✅ 通过   | 同一 task 完成建立 conversation、archive、侧栏消失、原 canonical 页面/turn 恢复、后续 send/wait 与 artifact 捕获；conversation ID、PID、旧 transcript 保持，两个对照 conversation 的侧栏计数始终不变。                                                 |
| VER-010 | ✅ 通过   | `0ccb41a432f0608cbf0bfba5a4c20fa964ac4ebc` 后重跑格式、lint、类型、91 项全量测试、CLI help、无宿主 `package.json` 的绝对路径 help；入口和两个 wait 时长参数均检查通过。                                                                                |
| VER-011 | ✅ 通过   | `0ccb41a432f0608cbf0bfba5a4c20fa964ac4ebc` 后重跑 10 个真实子进程恢复与并发测试及两连接 close 状态门回归；原子 capturing 恢复矩阵、并发 close 与 closed 分支无写入均通过。                                                                             |
| VER-012 | ✅ 通过   | 最低 Node v22.19.0 与当前 Node 的版本、`node:sqlite`、最小 TypeScript 入口 smoke test，以及固定 Playwright CLI help 均退出 0。                                                                                                                         |
| VER-013 | ⚠️ 部分   | 两个独立宿主 Agent 已分别自主选择 `.tar.gz` 与 `.zip`，完成 100 个带 marker/xattr 的 regular code files、归档参数/成员/元数据、本地解压、send 参数和 Web 唯一上传项核对；两次唯一有限 wait 均返回 pending，缺 Pro 侧 100 文件、全部 marker 与摘要。    |
| VER-014 | ✅ 通过   | 独立宿主 Agent 的真实 Skill+CLI fixture 对四场景分别只调用一次 wait，记录 CLI/gate/command PID、页面检查、静默输出和唯一终态；当前相关修改后的定向 pending fixture 继续证明三次页面检查、唯一 pending 终态、`error=NULL` 与 lease 清空。               |
| VER-015 | ✅ 通过   | `ba09c01` 后的新 live task 用一次有限主 `wait` 捕获七次 occurrence、六个有序唯一目标与六个可读文件，SQLite completed 不变量、重复去重、HTTPS 排除、同名不覆盖及重复 wait 路径一致均实查；58 项确定性测试继续覆盖页面函数、超时、终止、错误保码与恢复。 |

## 5. 最终确定性检查

| 检查                                                                        | 结果                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm format:check`                                                         | ✅ 49 个文件格式通过                                      |
| `pnpm lint`                                                                 | ✅ 退出码 0                                               |
| `pnpm typecheck`                                                            | ✅ 退出码 0                                               |
| `pnpm test`                                                                 | ✅ 8 个 test file、91 个测试通过                          |
| `pnpm exec vitest --run tests/state-concurrency.test.ts`                    | ✅ 10 个真实子进程恢复与并发测试通过                      |
| `pnpm exec vitest --run tests/browser.test.ts`                              | ✅ 25 个浏览器边界与可执行页面 fixture 测试通过           |
| `pnpm exec vitest --run tests/collab.test.ts`                               | ✅ 26 个服务边界、deadline、状态与重试测试通过            |
| `pnpm exec vitest --run tests/browser-command-gate.test.ts`                 | ✅ 8 个 gate 生命周期测试通过，含 artifact 取消全链路终止 |
| `pnpm collab -- help`                                                       | ✅ 退出码 0；wait usage 含两个独立时长参数                |
| 无 `package.json` 临时目录中用绝对路径执行 `collab.ts help`                 | ✅ 退出码 0                                               |
| Node v25.9.0 与 Node v22.19.0 的 `node:sqlite` 和 TypeScript CLI smoke test | ✅ 两个版本均退出码 0                                     |
| `npx -y @playwright/cli@0.1.17 --help`                                      | ✅ 退出码 0                                               |
| `git diff --check`                                                          | ✅ 退出码 0                                               |
| 任务账本 `spec-tasks diff`                                                  | ✅ Spec/context 无漂移                                    |
| 任务账本 `spec-tasks check --ready`                                         | ✅ `ok=true`；12 BEH、15 VER、8 IMP 均 ready              |
| 任务账本 `spec-tasks check --final`                                         | ⚠️ 退出 1；准确列出仍为 implemented 的四个 IMP            |

`spec-tasks diff` 返回 `specChanged=false`、`contextChanged=false`、无 impacted task；`check --final` 的四项错误依次为 IMP-001、IMP-003、IMP-006、IMP-007 必须为 `done` 或 `cancelled`。`implemented` 只证明实现提交与相关检查已取得，可满足下游实施依赖；它不代表全量 VER 或 Review 已通过。IMP-002、IMP-004、IMP-005 与 IMP-008 的实现、负责 VER 和 Review 证据已收口为 `done`；其余任务保留真实 VER 或 P1 复审缺口。

## 6. 失败尝试与边界

- 一次并发 live 复验中 Task A 的远端生成超过 300 秒仍为 pending；Task B 仍完成六文件捕获。停止该 runner 并显式关闭两个会话，未把远端未完成写成产品实现失败或验证通过。
- 专用 archive 全链路复验的第一条简单回复超过 120 秒仍未完成，因此没有进入 archive 阶段。继续重试不会引入新假设或证据来源，依照 Spec 停止重复尝试。
- 本轮第一次 VER-004 task `15ae8431-f02a-4b8a-8daf-2ad3f1ba6398` 的 600 秒观察窗口返回 pending；该 task 随后关闭。待并发远端任务结束后，使用更短但仍满足“长文本+代码块”的新 prompt 和新 task 取得了完整 VER-004 证据；未把前一次 pending 冒充通过。
- VER-013 两个独立宿主任务的远端唯一有限 wait 均返回 pending。协调员明确禁止未经授权重跑，因此只把归档选择与本地/Web 上传事实记为部分证据，未取得的 Pro 解压、marker 和摘要保持缺口。
- VER-013 pending 行同时暴露 confirmed submission 仍保留 `unknown-submission` 陈旧 `error`；`7255f52` 已最小修复并在 live-compatible pending fixture 复验 `error=NULL`。独立 Review `task_1775af5d8e88` 的 status `msg_125124b44bcc` 与 worker_done `msg_2072e50a65b2` 均判定 accepted、无 P1/P2/P3 finding。
- VER-013 两名独立 Agent 的报告、归档成员清单、VER-014 报告、Collab task session 与 SQLite 审计证据继续保留；本轮源夹具、解压目录、归档包、临时 prompt 与页面检查辅助脚本已移入系统废纸篓的独立目录，可恢复。认证 seed 未删除或改写。
- 用户已裁决 F1/F2 冲突：`pending` 是原子捕获边界前的本地状态，完整 Copy/artifact 描述取得后才进入 `capturing`。Spec、实现、恢复矩阵、VER-011 与 VER-015 已按这一选择统一，不新增状态、兼容或 migration gate。
- 首次 live 重跑创建的 task `3a577a54-bd5f-4a04-a610-84c511810fbf` 因既有开发数据库缺少 `artifact_set_recorded` 而在创建 turn 与 Web 提交前失败；task 随后成功关闭。协调员确认旧开发数据无需保留并授权精确删除；当时只有 `/Users/codeartz/.local/chatgpt-pro-collab/state.sqlite` 存在，`state.sqlite-wal` 与 `state.sqlite-shm` 不存在，认证 seed 未删除。当前实现随后创建全新数据库并完成 live VER-015；旧数据库未备份、不可恢复。
- 先前 live 临时根已按旧记录移入系统废纸篓；本次通过证据保留在 Collab 的 task session 与当前 SQLite 中，临时 `.ver015-live-prompt.md` 已删除。
- `ba09c01` 后的 VER-015 live 证据保留在 task `f44b6453-b56a-471a-8c39-606291de98f2` 的 session 与当前 SQLite 中；临时 `.ver015-post-ba09-live-prompt.md` 已删除，认证 seed 未删除或改写。
- 根 Review Task `task_f83d3a0d427b` 的稳定证据已写入每个 IMP：reviewer conversation/session 始终为 `019fcdfa-ef5f-7410-a245-6bbaf7be52dd`，最终 closure status `msg_19d1aefb2cb6`、worker_done `msg_e00d44341bfe`，F1–F5 全部关闭。pending-error 独立 Review `task_1775af5d8e88` 已 accepted；repeated-close 独立 Review `task_d8758885857a` 的 status `msg_464a398c1f50` 与 worker_done `msg_65fce671152b` 提出 P1，`0ccb41a` 等待同一 reviewer conversation/terminal `term_1f28048f-d0f0-44b1-92f0-18251e33850c` 复审，不记录关闭结论。

## 7. 交付前检查

- [x] IMP-001 至 IMP-008 按 `dependsOn` 顺序形成目的单一提交。
- [x] Live 发现的归档恢复和返回文件 DOM 映射问题已最小修复并复验相关路径。
- [x] F1 已关闭；F2 的 post-freeze artifact download watchdog、终止、lease 释放、剩余行重试及修改后的 VER-015 live 主路径已复验。
- [x] 账本保留根 Review 和 pending-error 独立 Review 的真实关闭证据；repeated-close P1 只记录 finding 与待复审状态。
- [x] 明确区分完整通过、部分证据和未取得证据。
- [ ] VER-001 fresh setup 仍按用户决定不重跑；因此 VER-002、VER-006 的必需前置仍缺。
- [ ] VER-013 双宿主已完成归档选择与上传边界，但两次 live wait 均 pending，仍缺 Pro 解压 100 文件、全部 marker 与摘要。
- [ ] `0ccb41a` 的 repeated-close P1 修复等待 `task_d8758885857a` 的同一 reviewer conversation 复审；不得用根 Review 或 `task_1775af5d8e88` 的结论替代。

## 8. 最终判断

根 Review F1–F5 与 pending-error 独立 Review 均已关闭；VER-004、VER-007、VER-008、VER-009 与 VER-014 的严格证据已补齐，VER-013 仍缺 Pro 终态。IMP-002、IMP-004、IMP-005、IMP-008 为 `done`；IMP-001 因 VER-001/002、IMP-003 因 VER-013、IMP-006 因 VER-006、IMP-007 因 repeated-close P1 待原 reviewer conversation 复审而保持 `implemented`。完整规格仍不能最终验收，`check --final` 必须如实反映这些缺口。
