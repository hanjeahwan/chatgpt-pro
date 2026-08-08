# ChatGPT Pro 浏览器协作

- status: review
- version: 0.1

## 背景与目标

本产品是宿主 Agent 与 ChatGPT Pro Web 之间的轻量协作通道。宿主 Agent 决定任务内容、本地文件范围和协作方式；Collab 负责维护浏览器会话、发送明确输入、在浏览器层等待回复，并保存原始文字与返回文件的可审计记录。

目标是让一个宿主同时维护多个互不影响的 Pro 任务，并在每个任务中持续多轮对话。成功时，宿主可以在任务 A 等待长时间回复期间继续操作任务 B；进入等待后不需要由宿主 Agent 反复检查页面，每项任务仍有独立浏览器进程、独立 Web conversation 和独立 transcript。

本版不承担仓库理解或代码集成。宿主 Agent 与 Pro 可以按任务选择文字、git patch、归档文件或其他产物协作；Git 工作区、worktree、输入归档内容、返回产物解释、patch 应用、合并和冲突处理都由宿主 Agent 或用户决定，不进入 Collab 运行时协议。

## 产品行为合同

### BEH-001 一次登录设置

- **触发与前置条件**：用户执行 `setup`，本机可以打开 ChatGPT Web。
- **可观察行为**：Collab 打开一次交互式登录流程，并在用户完成登录后保留可供后续任务加载的本地认证源；`setup` 完成后关闭本次设置使用的浏览器。`setup` 在认证源保存前后被中断时，后续同一命令先核对持久状态：认证源未保存时重新进入登录流程；认证源已经有效时只完成尚未完成的 setup session 清理，不要求用户重复登录。
- **验收条件**：完成一次人工登录后，两个后续任务都能在不再次要求用户登录的情况下进入已登录的 ChatGPT Web。认证源保存前中断不会留下成功记录，保存后但浏览器关闭前中断可由后续 `setup` 清理；恢复不删除有效认证源，也不把无法验证的认证源报告为成功。
- **状态**：已确认。

### BEH-002 启动独立任务

- **触发与前置条件**：宿主预先生成一个在其协作范围内稳定且唯一的 canonical lowercase UUID v4 `taskId`，执行 `start(taskId)`，且 BEH-001 的认证源可用。
- **可观察行为**：Collab 为该 `taskId` 创建独立浏览器进程、独立 browser context 和独立会话目录；只读加载 BEH-001 的认证源后，在现有 Project 中精确定位唯一名为 `chatgpt-pro-collab` 的 Project，进入该 Project 的空白新 conversation composer，并把模型固定选择为 `GPT-5.6 Sol`、Power 固定设置为第五级（`5/5`）。Collab 只有在重新读取页面并确认 Project、模型和 Power 都正确后才返回同一个 `taskId`；首次成功发送时，任务固定绑定由该 Project composer 建立的新 conversation。相同 `taskId` 的重复或并发 `start` 只在 task 仍为 `starting`，或已完成启动但尚未绑定 conversation 时恢复或返回同一次启动，不创建第二个 task、browser context 或新 conversation composer；task 已绑定 conversation、正在关闭、已经关闭、失败或与持久状态冲突时返回冲突。Collab 不自动创建或修改 Project，也不创建 task 认证状态副本。
- **验收条件**：成功返回时，页面位于唯一 `chatgpt-pro-collab` Project 的新 conversation composer，模型回读为 `GPT-5.6 Sol`，唯一 Power slider 的当前值等于最大值且表示第五级（`5/5`），且页面尚无 user turn；任意两个不同 `taskId` 的活动任务具有不同的浏览器进程、browser context 和会话目录，首次发送后在同一 Project 中建立不同 conversation；启动新任务不因其他未关闭任务而拒绝。在浏览器创建、认证加载、Project 导航或固定模型与 Power 确认前后中断时，使用同一 `taskId` 重试可核对并继续同一次启动。Project 缺失或不唯一时，错误建议用户检查登录账号以及手动创建或整理 `chatgpt-pro-collab` Project；固定模型或 Power 不可用、选择失败或结果无法回读时，错误指出无法确认的固定目标。所有失败都不返回成功结果，且不得调用 Project 创建或修改操作。
- **状态**：已确认。

### BEH-003 发送明确输入

- **触发与前置条件**：宿主对活动任务执行 `send(taskId, promptPath, attachmentPaths[])`；该任务没有未完成 turn；所有传入路径均由宿主明确指定且当前可读。新 task 尚未绑定 conversation 时，宿主已按 Skill 把固定协作合同与当前任务写入同一 prompt 文件。
- **可观察行为**：新 task 的第一条 user message 同时包含固定协作合同、当前任务和当轮附件；协作合同定义 Pro 作为承担有界任务的独立协作者，明确双方责任、宿主环境可观察边界、会话工具使用、前提质疑、假设与阻塞处理、后续轮次连续性和宿主最终验证与集成责任，并要求 Pro 直接处理当前任务而不只确认模式，但不要求固定回复格式。Collab 输入选择层只解析并读取 `promptPath` 与 `attachmentPaths` 中明确列出的文件，不隐式注入或改写 prompt；它先持久化本轮输入与提交阶段，再向该任务的 conversation 提交一次消息，随后立即返回唯一 `turnId`，不等待 Pro 完成回复。提交前中断时，恢复清理或重建为可安全发送的相同 composer；提交命令已经释放但结果未返回时，Collab 先通过页面证据自动判断是否已提交，不能证明时将 turn 保持为 `unknown-submission`，禁止自动重发。
- **验收条件**：`start` 成功后、首次 `send` 之前不存在单独的启动 user turn；首轮 Web prompt 与指定文件一致，且完整包含一份固定协作合同和当前任务。输入选择层的文件访问记录只包含指定 prompt 和附件；未列出的仓库输入不会被该层枚举、打开、打包或上传；调用方在消息提交完成后取得 `turnId`。附件上传期间中断且尚未释放提交命令时，恢复后页面没有残留或重复附件，原 turn 记为 `failed`，只有宿主再次显式 `send` 才建立新 turn，且该 prompt 仍包含完整协作合同；提交结果不明确时不会产生自动重发，后续行为遵守 BEH-013。
- **状态**：已确认。

### BEH-004 等待并捕获原始回复

- **触发与前置条件**：宿主执行 `wait(taskId, turnId, observationWindowMs, captureTimeoutMs)`，该 turn 已提交，且两个时长都是宿主提供的有限正整数。
- **可观察行为**：Collab 在观察窗口内检查该 turn 的 Pro 回复。只有目标 assistant 的 Copy 可见、页面没有可见的 `Stop answering`，并满足既有稳定检查时才报告网页完成；完成观察同时返回经过检查的 assistant DOM identity，本次 pending→capture 显式传入该 identity，capture 只接受同一个 assistant，不重新选择后来出现的 latest assistant。网页报告回复完成后，Collab 在本次 `captureTimeoutMs` 的宿主侧单调 deadline 内取得 Web 端完整 Copy response 与完整有序 artifact 描述，再以一个 SQLite 事务建立 `capturing` 边界；事务后把原始文字写入该 turn 专属且不覆盖其他 turn 的 `response.md`，并完成 BEH-012 的返回文件捕获。`observationWindowMs` 只约束网页完成观察；`captureTimeoutMs` 从网页报告完成或本次调用开始恢复 `capturing` turn 时计时，约束本次完整文字与剩余文件捕获。观察窗口到期而网页尚未报告完成时返回 `pending`；捕获超时或浏览器发生真实错误时返回错误。Stop 持续可见时不点击 Stop、不自动 reload，也不因内容稳定或看似完整而捕获。
- **验收条件**：`completed` 只在正常完成条件成立，且 `response.md` 与全部返回文件均已落盘后返回。观察与捕获之间若原 assistant identity 缺失、重复或漂移，必须在 Copy 前失败，turn 保持 `pending`；后续 `wait` 重新观察。`pending` 是已成功提交但尚未取得完整 Copy response 与 artifact 描述并建立原子 `capturing` 边界的本地持久化状态，不声称 Pro 必然仍在生成。取得完整数据前超时返回 `CAPTURE_TIMEOUT` 或发生其他真实错误时 turn 保持 `pending`，后续 `wait` 重新观察并重取 Copy；进入 `capturing` 后超时、中断或下载失败则保持 `capturing`，后续 `wait` 使用新的 `captureTimeoutMs` 按恢复矩阵继续，且不新增持久 assistant identity。同一 completed turn 再次 `wait` 返回同一 `responsePath` 和文件路径；调用方中断不会停止远端生成，后续仍可再次 `wait`。
- **状态**：已确认。

### BEH-005 同一任务持续多轮

- **触发与前置条件**：前一 turn 已完成，任务仍活动。
- **可观察行为**：宿主可再次执行 BEH-003 和 BEH-004；所有 turn 继续使用同一个浏览器进程和同一个 conversation，并分别保存输入与回复。后续 prompt 依赖首轮已建立的协作上下文，不重复固定协作合同。
- **验收条件**：后续回复能使用此前 conversation 的上下文；每个 turn 有独立 `turnId` 和文件记录；同一任务同一时间最多存在一个未完成 turn。
- **状态**：已确认。

### BEH-006 多任务真实并发且隔离

- **触发与前置条件**：至少两个任务处于活动状态。
- **可观察行为**：不同任务可同时执行上传、发送、等待和回复捕获；一个任务的长时间生成、失败或关闭不暂停其他任务。
- **验收条件**：任务 A 与任务 B 能在时间上重叠地等待 Pro 回复；各自的 prompt、附件、conversation、回复和 transcript 不交叉；实现不是用同一浏览器进程串行轮询来模拟并发。
- **状态**：已确认。

### BEH-007 保留逐 turn 审计记录

- **触发与前置条件**：任务启动，或 task、turn、operation 状态发生变化。
- **可观察行为**：Collab 在 `~/.local/chatgpt-pro-collab/` 下保留 task、turn、未完成浏览器副作用与返回文件元数据，并为每个 turn 保存 prompt 副本、原始附件路径清单、状态、完整 response 和 BEH-012 下载的文件。恢复采用的页面证据、自动判定或人工裁决来源进入审计记录。新 turn 不覆盖旧 turn；宿主之后改写原始 `promptPath` 不改变已保存副本。
- **验收条件**：任务关闭后仍能按 `taskId` 和 `turnId` 复原文字交互次序、返回文件顺序、本地路径，以及未完成副作用的恢复与裁决结果；重复使用同一输入或返回文件名不会改变旧记录；发送附件正文不因审计目的被额外复制。人工裁决记录包含操作者给出的结论、验证到的页面身份、时间和结果，但不把人工结论伪装为自动证明。
- **状态**：已确认。

### BEH-008 关闭本地任务

- **触发与前置条件**：宿主执行 `close(taskId)`。
- **可观察行为**：Collab 在终止浏览器前把 task 持久化为 `closing`，终止该任务的浏览器进程并确认 session 不存在后再置为 `closed`，同时保留 BEH-007 的 transcript 和 BEH-001 的共享认证源。`close` 不归档或删除 Web conversation，也不修改用户仓库。
- **验收条件**：浏览器进程不再存在；transcript 和共享认证源仍可读取；Web conversation 保持原状态；`close` 中断后再次执行可继续清理，重复 `close` 不产生额外副作用。
- **状态**：已确认。

### BEH-009 显式归档 Web conversation

- **触发与前置条件**：宿主对活动任务执行 `archive(taskId)`。
- **可观察行为**：Collab 只在 ChatGPT Web 归档该任务绑定的 conversation；归档命令释放前先记录目标 canonical identity，命令中断后先观察该 conversation 的实际归档状态，再决定完成恢复或在证明确未归档时重试。归档不隐式关闭本地任务，也不处理其他 conversation。
- **验收条件**：指定 conversation 进入 Web Archive；任务的本地进程和 transcript 不变；对已关闭任务调用时返回明确错误且不静默重启浏览器。归档点击前后或页面恢复期间中断时，后续恢复不会对无法判定状态的 conversation 再次点击 Archive；已归档时只恢复原 canonical 绑定，证明确未归档时才重试。
- **状态**：已确认。

### BEH-010 用归档文件批量传递输入

- **触发与前置条件**：宿主 Agent 已明确选择本轮输入范围，并判断逐个上传大量文件不合适。
- **可观察行为**：宿主 Agent 在 `send` 前把所选输入打包为一个归档文件；代码任务默认使用 `.tar.gz`，跨平台交付、任务约定或接收方需要时使用 `.zip`。Collab 把生成的归档文件当作一个不透明附件上传，不扫描仓库、不自行增补内容，也不要求 manifest、固定目录结构或固定协作协议。少量文件仍可直接逐个上传。
- **验收条件**：Web 端只收到 prompt 与宿主明确列出的直接附件或归档附件；一个包含大量所选文件的归档只占一个上传项；Pro 能在沙盒中解压并使用其内容；归档中不存在宿主未选择的文件。
- **状态**：已确认。

### BEH-011 等待期间不唤醒宿主 Agent

- **触发与前置条件**：宿主 Agent 对已提交的 turn 发起一次 BEH-004 `wait`。
- **可观察行为**：Collab 在该次 CLI 调用内按内部节奏持续检查页面；普通轮询不输出进度，也不产生宿主可见的中间结果。`wait` 只在回复及文件捕获完成、观察窗口到期或发生真实错误时返回一次终态结果。
- **验收条件**：完成、观察到期、捕获超时和其他真实错误场景都只调用一次 `wait` 并得到一次终态结果；内部发生多次页面检查时，宿主 Agent 不重复调用 `wait`，也不另行轮询浏览器。该行为不禁止用户主动中断、宿主 Agent 操作其他任务或在前一次调用返回后显式发起新的观察窗口，也不停止 Pro 生成。
- **状态**：已确认。

### BEH-012 捕获目标回复中的全部返回文件

- **触发与前置条件**：目标 assistant turn 已完成，且其中可能包含指向 `sandbox:/mnt/data/...` 的文件链接。
- **可观察行为**：Collab 只检查该 turn，按出现顺序下载其中全部唯一 `sandbox:` 文件链接，不限制文件格式；普通 `https:` 等引用链接不自动下载。完整 Copy response 原样保留在 `response.md`，每个文件保存到不会因同名而碰撞的 turn 专属路径。Collab 不解压、解释、执行或应用下载内容。
- **验收条件**：同一 `sandbox:` 目标只下载一次；多个同名文件不会相互覆盖；没有返回文件时得到空文件列表。取得完整 Copy response 与有序 artifact 描述前达到 `captureTimeoutMs` 时返回 `CAPTURE_TIMEOUT` 并保持 `pending`；原子进入 `capturing` 后，任一文件下载失败或整轮捕获超时时不把 turn 标为 completed，后续 `wait` 复用已成功保存的文件并继续未完成项。网页完成在观察窗口到期前被观察到后，即使文字或文件捕获跨过该窗口也不返回成功的 `pending` 结果，只会在全部完成后返回 `completed`，或在捕获超时及其他真实错误时返回错误。
- **状态**：已确认。

### BEH-013 检查并恢复中断状态

- **触发与前置条件**：宿主执行 `status(taskId)` 检查任务，执行 `recover(taskId)` 恢复中断操作，或对无法自动判定的 `unknown-submission` 执行 `resolve-submission`；本地 task、turn 或 operation 记录仍可读取。
- **可观察行为**：`status` 只读取持久状态与当前 browser session 可用性，返回 task、turn、未完成 operation、最近证据、错误和唯一安全的 `nextAction`，不执行远端副作用。`recover` 取得该 task 的互斥 lease 后，按持久阶段与页面后置条件继续 setup 之外的启动、发送准备、浏览器重建或归档恢复；`pending` 或 `capturing` turn 的下一步仍是使用原参数合同执行 `wait`，关闭恢复仍由幂等 `close` 承担。浏览器进程退出时，未绑定 conversation 的任务从共享认证源重建同一 Project composer；已经绑定的任务只导航到记录的 canonical URL，并核对唯一 conversation identity 与相关 turn 后恢复。任何恢复都不自动重发消息。
- **验收条件**：可自动证明的状态由系统恢复到既有安全命令入口；无法自动证明首次消息是否提交且尚无 canonical identity 时返回 `nextAction: resolve-submission`。`submitted` 裁决必须提供 canonical conversation URL，Collab 必须在已登录页面中验证其属于唯一 `chatgpt-pro-collab` Project；task 已有绑定时还必须与已记录 conversation identity 相同，随后把位于已记录前一 turn 锚点之后、与已保存 prompt 及有序附件名称一致的唯一 user turn 绑定到原 `turnId` 后才能置为 `pending`。`not-submitted` 裁决由用户提供“未提交”的权限性事实，Collab 仍须验证页面已经恢复为该 task 已绑定 conversation 的安全 composer，或在尚未绑定时恢复为唯一目标 Project 的空白安全 composer，且预期锚点之后没有匹配 user turn 或进行中的发送状态；之后把原 turn 置为 `failed`，由宿主另行显式 `send`。该验证不被表述为对历史未提交的自动证明。页面身份、输入或附件不匹配、候选 turn 不唯一、页面不可用或裁决与持久状态冲突时，不改变原状态。两个裁决分支都不自动发送消息。
- **状态**：已确认。

## 产品边界

- 宿主 Agent 对 prompt、附件与归档内容选择负责。宿主可以为 BEH-010 读取并打包明确选择的输入；Collab 输入选择层只解析和读取 BEH-003 明确传入的路径，不枚举或打开其他仓库输入。该边界不约束 Node.js、npm/npx、浏览器或操作系统读取其运行依赖、配置与缓存。Collab 运行时把附件视为不透明文件，不判断秘密、不检查 Git 状态，也不因 symlink、dirty worktree、分支或项目布局设置额外安全门。
- Collab 只操作由 BEH-001、BEH-002、BEH-009 和 BEH-013 指定身份边界内的 ChatGPT Web 页面，不代替用户进行仓库修改、命令执行、patch 应用、提交、合并或发布。
- Pro 回复与返回文件都是原始协作输出。Pro 可以返回文字、git patch、`.tar.gz`、`.zip` 或其他产物；Collab 不要求固定回复格式，不识别或自动应用 diff、digest、receipt 或成功标记，不自动重发 prompt，也不根据回复内容阻塞后续宿主行为。宿主 Agent 负责验证、解压、执行、修改或应用这些输出。
- 固定协作合同只定义双方责任、可观察边界和协作方式；不固定任务类型、回复 schema、产物格式或宿主必须采用的结果。
- 认证源只保存在本机，不作为附件上传。各任务只读加载同一认证源，运行期间产生的 cookie 或 Web Storage 变化只保留在各自的内存 browser context；本版不新增 Unix 权限模式合同。
- 浏览器可见性、自动最小化、Dock 图标管理和返回产物自动集成不在本版产品合同内。BEH-013 只在同一登录账号、固定 Project、原 `taskId` 与已记录 canonical conversation identity 内恢复；不迁移 conversation，不恢复已删除或当前账号无权访问的 conversation，也不绕过 ChatGPT Web 的登录与权限检查。

## 技术基线

以下 checkout 事实共同约束技术设计和验证方式：

- 当前 checkout 已有 `skills/chatgpt-pro-collab/` 实现、`tests/` 自动化测试以及可从任意宿主目录执行的绝对路径 CLI 入口。现有代码已承载 setup、start、send、wait、capture、artifact、archive、close、status、recover、resolve-submission、browser-operation lease、通用 operation journal、浏览器进程重建和逐 turn transcript 的实现基线；BEH-013、调用方提供稳定 `taskId` 和公开的提交裁决命令均已实现。全部行为仍须按当前 VER 重新验证，不能把已有测试结果视为当前规格已通过。
- 运行约束为 Node.js `>=22.19.0`、ESM、TypeScript `^6.0.3` 和 Vitest `4.0.18`；格式化和 lint 分别使用 oxfmt 与 oxlint。当前 `tsconfig.json` 已采用 Node 原生 TypeScript type stripping 所需的 `erasableSyntaxOnly`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions` 与 `noEmit` 约束（REF-003）。
- 当前 manifest 没有浏览器自动化或数据库 npm dependency；`browser.ts` 固定调用 `@playwright/cli@0.1.17`，并已实现 named session、storage state 保存与加载、显式附件上传、有界页面检查、页面内文字捕获和归档后恢复绑定 conversation。固定 CLI 的命令能力由版本化官方资料承载（REF-001）。
- 当前 `state.ts` 使用 Node.js 标准库同步 `DatabaseSync` 保存 task、turn、artifact、operation journal 和 browser-operation lease，并以 `pending → capturing → completed` 及无覆盖文件发布支持捕获恢复；schema 已承载覆盖 setup、start、send 准备与 archive 的 operation journal 和稳定的 browser 重建状态（REF-002）。
- 当前 `send` 已记录提交释放边界并在结果不明时保留 `unknown-submission`；提交证明或 BEH-013 的 `submitted` 裁决后持久化精确 user turn identity 与 canonical conversation identity，`not-submitted` 裁决在验证安全 composer 后把原 turn 置为 `failed`；附件已进入 Web draft、但提交命令尚未释放时的进程中断已有持久恢复阶段。
- 当前 `wait` 已支持有限观察、原子冻结 response 与 artifact 集、复用已完成文件及继续未完成下载；`close` 可重复调用且先持久化 `closing` 状态再终止浏览器。当前 `start` 接受调用方提供的稳定 `taskId`，中断后可用同一身份继续恢复；`archive` 已覆盖点击前后进程退出的持久后置条件核对；task browser 退出后从 seed 与 canonical identity 重建。

## 技术设计

### 实现机制与最小性

- **BEH-001–BEH-013 的 CLI 运行入口**：使用 Node.js 原生 type stripping 直接执行 ESM TypeScript，不生成运行产物，不引入 Jiti、tsx 或其他运行时转译器。运行代码只允许可擦除 TypeScript 语法，类型正确性由独立 `typecheck` 保证（REF-003）。
- **BEH-003 的首轮协作合同**：由 Skill 指导宿主在 task 尚未绑定 conversation 时，把固定协作合同和当前任务写入为首条 user message 发起的每个 prompt 文件，并与当轮附件一次提交。Collab CLI 把组合后的 prompt 视为不透明输入，不注入、解析或去重合同；`start` 不增加启动 turn，conversation 绑定后的轮次不重复合同。
- **BEH-010 的输入归档**：由 Skill 指导宿主 Agent 使用当前执行环境已有的归档工具生成 `.tar.gz` 或 `.zip`，并在调用 `send` 前检查归档成员与所选输入一致。归档不得携带会在 Pro 沙盒中物化为额外文件的宿主扩展属性；macOS bsdtar 的目标命令使用 `COPYFILE_DISABLE=1` 和 `--no-xattrs`。Collab CLI 不增加 pack 命令，也不增加归档 dependency、manifest 或目录 schema。
- **BEH-001–BEH-006、BEH-008、BEH-009、BEH-012 与 BEH-013 的浏览器边界**：固定使用 `@playwright/cli@0.1.17`。`browser.ts` 通过参数数组调用 `npx -y @playwright/cli@0.1.17`，不经 shell 拼接，也不把 Playwright 写入项目 dependency。本版使用 setup 生成的 storage state 作为共享只读认证源；这里的只读表示 task 不回写 seed，不要求修改文件权限。每个 task 使用由 `taskId` 确定的独立 named session 和独立内存 browser context（REF-001）。
- **BEH-011 的单次等待调用**：一次 `wait` 对应一个前台 CLI 进程。页面检查与等待全部在该进程内完成；CLI 在终态前不输出应用进度，结束时只返回一条终态 JSON。Skill 只发起这一次调用，不由 Agent 重复执行 `wait` 或另行检查浏览器来模拟订阅。
- **BEH-001–BEH-009、BEH-011–BEH-013 的跨命令协调状态**：继续使用 Node 标准库 `node:sqlite` 的同步 `DatabaseSync`。SQLite 保存 task、turn、返回文件、operation journal 和 browser-operation lease 的协调状态；逐 turn 文件保存可审计正文与返回产物（REF-002）。
- **BEH-001、BEH-003、BEH-004、BEH-007 与 BEH-012 的文件状态**：除 `state.sqlite` 外，文件系统保存认证数据、prompt、response、下载的返回文件和 Playwright 运行产物。SQLite 与 transcript 职责分开，不用 JSON 元数据文件复制数据库状态。

### 组件与职责

| 组件                      | 文件或边界                                     | 承载行为                                            | 职责                                                                                           |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Skill entry               | `skills/chatgpt-pro-collab/SKILL.md`           | BEH-001–BEH-013                                     | 触发边界、首轮协作合同、归档输入准备、恢复路由、宿主职责和 CLI 阶段路由；不复制页面或 SQL 实现 |
| CLI                       | `skills/chatgpt-pro-collab/scripts/collab.ts`  | BEH-001–BEH-009、BEH-011–BEH-013                    | 参数解析、观察窗口、命令与恢复路由、单一终态结果和错误输出                                     |
| Browser boundary          | `skills/chatgpt-pro-collab/scripts/browser.ts` | BEH-001–BEH-006、BEH-008、BEH-009、BEH-012、BEH-013 | Playwright CLI 进程调用、页面动作、后置条件核对、目标 turn 完成检测、文字与文件捕获、归档      |
| State store               | `skills/chatgpt-pro-collab/scripts/state.ts`   | BEH-001–BEH-009、BEH-011–BEH-013                    | `node:sqlite` schema、事务、task/turn/artifact/operation 状态、operation lease 和并发写入      |
| Transcript/artifact store | `skills/chatgpt-pro-collab/scripts/session.ts` | BEH-001、BEH-003、BEH-004、BEH-007、BEH-012         | 数据目录、认证源、prompt/response 与返回文件的无覆盖发布、已有文件复用和一致性检查             |

不创建自定义常驻 task worker、全局 daemon 或新的 IPC 协议。Playwright CLI named session 保持每个 task 的浏览器实例；SQLite 保持跨命令状态。每次 Collab CLI 调用只打开所需数据库连接并调用目标 named session，因此两个 `wait` 进程可以并发操作不同 task，而同一 task 的状态门禁止第二个未完成 turn。

### 输入归档合同

- 宿主 Agent 先确定本轮输入集合，再决定直接附件或归档；不能为了方便打包而扩大已选择范围。代码任务需要批量传递时默认生成 `.tar.gz`，跨平台接收、任务明确要求或目标工具更适合 ZIP 时生成 `.zip`。
- 归档只包含所选 regular file 与承载其相对路径所需的目录项，不包含宿主扩展属性、resource fork、AppleDouble 或其他平台元数据。macOS bsdtar 生成 `.tar.gz` 时必须同时设置 `COPYFILE_DISABLE=1` 和 `--no-xattrs`；只设置 `COPYFILE_DISABLE=1` 不满足该合同。
- 归档成员路径、根目录、是否包含 git patch 或说明文件都由本轮协作需要决定。Skill 不规定 manifest、哈希、固定顶层目录或固定返回协议。
- 生成后必须在本地列出归档成员并与选择结果核对，再把该归档路径作为一个 `attachmentPath` 传给 `send`。归档临时文件是否保留由宿主决定；Collab 只记录其发送时绝对路径。
- Pro 在沙盒内自行解压并根据 prompt 工作；Collab 不发送额外解压控制消息，也不验证 Pro 的工作方法。

### Playwright CLI 合同

- `browser.ts` 使用固定命令前缀 `npx -y @playwright/cli@0.1.17 -s=<sessionName> --raw`；task session name 确定为 `chatgpt-pro-collab-<taskId>`，同一 task 的启动重试与重建不得生成新名称。不同 task 不共享 session name、browser context 或输出目录，只共享只读认证源路径。
- `setup` 使用写入 operation journal 的独立 setup session，通过 `open https://chatgpt.com/ --browser=chrome --headed` 完成人工登录。确认已登录后执行 `state-save <seedStatePath>`，成功保存并重新验证 `auth/seed.json` 后关闭记录的 setup session；后续 `setup` 依据该记录清理中断遗留，不得保留完整 Chrome profile（REF-001）。
- `start <taskId>` 以由 `taskId` 确定且持久记录的 named session 执行 `open about:blank --browser=chrome --headed`、`state-load <seedStatePath>` 和 `goto https://chatgpt.com/projects`。登录确认后，启动脚本在 Project `role=row` 范围内精确匹配文本 `chatgpt-pro-collab` 并要求结果严格等于一项；进入该行后，联合核对 `/g/g-p-<id>/project` 路径、主区域内的精确 Project 标题和唯一可见空白 composer，不能把首页或既有 `/c/...` conversation 当作启动成功（REF-005）。相同 `taskId` 的重复调用只在 `starting` 或 active 且未绑定 conversation 时恢复该 task 的 operation 与 session，不重新分配身份；其他 task 状态在浏览器动作前返回冲突。
- Project 身份确认后，`start` 打开 composer 中唯一的模型与 Power 菜单，把模型精确选择为 `GPT-5.6 Sol`，并把唯一 Power slider 设置到其最大值。确认时必须回读当前模型为 `GPT-5.6 Sol`，且 Power slider 满足 `aria-valuenow == aria-valuemax`；当前五档控件使用零基 ARIA 值域 `0..4`，因此 `aria-valuenow == aria-valuemax == 4` 表示第五级（`5/5`），不得把第五级误写成 `aria-valuemax == 5`。即使当前页面已显示目标值也必须执行同样的回读确认。通用控件定位使用角色、层级、URL 和状态，不依赖 `Projects`、`New chat in...`、`Open project options...`、当前 Power 档位文案等会随页面语言或状态变化的文本，也不改变用户或浏览器语言。Project 名与模型名是 BEH-002 固定的目标值；Power 使用无障碍 slider 语义与数值状态确认，不依赖本地化档位名称。
- `start` 的 Project 定位、导航或模型/Power 确认发生已确定失败时，browser boundary 关闭已打开的 named session，服务层保留 `failed` task 记录但不返回成功结果。进程中断或效果无法判断时保留 `starting` task 与 operation，不能清理成确定失败。错误区分 Project 缺失或不唯一、固定模型或 Power 不可用、选择无法确认和页面合同漂移；任何分支都不得调用 Project 创建或修改控件。不同任务读取同一 seed 文件，之后产生的 cookie 或 Web Storage 变化只留在各自内存 browser context，不回写 seed。
- 启动、页面动作、上传、等待和关闭分别使用 `open`、`run-code --filename`、`upload`、`run-code --filename` 和 `close`。多个附件按 `attachmentPaths` 顺序逐个上传；BEH-010 生成的归档沿用同一单文件 upload，不增加特殊传输协议。会产生远端副作用的命令在实际 command PID 放行前先持久化 `effect-unknown`，正常结果返回后再以页面后置条件提交业务状态；进程退出不能绕过这两个边界。
- Playwright 子进程设置 `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true`，允许访问宿主传入的任意绝对附件路径；这个能力只扩大 CLI 文件读取边界，不改变产品边界中由宿主负责选择文件的合同（REF-001）。
- ChatGPT 专属 selector、conversation identity、完成检测、回复 Copy、返回文件发现与下载和 Archive 全部封装在 `browser.ts`。当前实现以 composer `#prompt-textarea`、send `[data-testid="send-button"]`、turn `[data-testid^="conversation-turn-"][data-turn]`、Copy `[data-testid="copy-turn-action-button"]`、conversation options `[data-testid="conversation-options-button"]` 和 `/c/<conversationId>` canonical identity 为基线；selector 找不到或不唯一时返回页面合同漂移，不猜测相邻元素。易变页面合同只能由对应 live VER 证明，不能因当前代码存在而视为通过。
- `wait` 以当前 turn 持久化的精确 user DOM identity 为锚点，只接受其后的 assistant turn；user target 缺失或不唯一时返回页面合同漂移，不退回 latest user turn。该 assistant 的 Copy 按钮可见、页面没有可见的 `Stop answering` 按钮且连续稳定检查通过时才判定完成。observation 返回该 assistant 的稳定 DOM identity，本次 pending→capture 显式传入并只接受该 exact identity；若 target 缺失、重复或漂移则在 Copy 前返回页面合同漂移，不重新隐式接受 T2。Stop 持续可见时继续内部检查并按观察窗口返回 `pending`，不点击 Stop、不 reload，也不按内容稳定性建立另一种完成模式。回复捕获在点击该 assistant 的 Copy 前临时拦截当前页面 `navigator.clipboard.write`/`writeText`，取得同一个 ClipboardItem 的 `text/plain` 和 `text/html` 后恢复原方法；`text/plain` 原样保存为 response，`text/html` 只用于当次文件发现。任一类型缺失时返回页面合同漂移，不读取或写入操作系统全局剪贴板。
- 同一个目标 assistant turn 同时作为返回文件发现边界。实现从 Copy response 的 `text/html` 按文档顺序提取 `sandbox:` anchor，按完整逻辑 URL 去重并保留首次出现位置；普通 `https:` 等链接不触发下载。去重前的 sandbox occurrence 与该 turn 中按文档顺序出现的 `button.behavior-btn` 按位置对应；数量不等时返回页面合同漂移。不得从其他 assistant turn、侧栏或页面其他区域发现文件（REF-004）。
- 目标 turn 的 artifact 行按首次出现顺序构成唯一 sandbox 目标的子序列。实现展开 artifact 列表，以逻辑目标 basename 和顺序把每行的 `Open file` 与同级 `Download file` 映射到对应目标；同名目标按顺序区分。映射到 artifact 行的目标通过行内 `Download file` 捕获 download event；未映射目标通过对应正文行为按钮捕获直接 download event。artifact 行无法形成无歧义子序列、事件没有发生或页面数量、顺序、控件关系发生变化时返回页面合同漂移，不猜测相邻控件（REF-004）。
- 每个唯一逻辑目标在页面动作前先建立 artifact 记录。`source_url` 保存完整 `sandbox:` 逻辑 URL；浏览器建议名称和带签名的实际下载 URL 只属于当次 download event，不作为目标身份。下载成功后使用建议名称作为原始名称，并保存到带 ordinal 的 turn 路径。
- 每次页面完成检查保持有界。服务层使用单调时钟分别控制 `observationWindowMs` 和 `captureTimeoutMs`；网页尚未报告完成且达到观察 deadline 时返回 `pending`。一旦观察到完成，观察 deadline 不再参与判断，服务在宿主侧 capture watchdog 内取得完整 Copy response 与有序 artifact 描述；此阶段达到捕获 deadline 时返回 `CAPTURE_TIMEOUT` 并保持 `pending`，后续 `wait` 重新观察并重取 Copy。取得完整描述后才以单个事务进入 `capturing`；捕获 deadline 继续覆盖本次调用的 response 发布与全部文件捕获，不按文件重新计时。turn 已经是 `capturing` 时从本次调用开始建立新的捕获 deadline；此后达到 deadline 时返回 `CAPTURE_TIMEOUT` 并保留 `capturing`。deadline 前发生的真实浏览器错误保留原错误码；watchdog 必须安全终止对应 command，不能遗留悬挂 command 或 operation lease。
- `archive` 只使用唯一的 `[data-testid="conversation-options-button"]` 和精确名称为 `Archive` 的 menuitem。脚本先观察 Archive menuitem，只有不可见时才打开菜单，避免把已打开菜单反向关闭；不得用模糊的 `Open conversation options` 匹配侧栏按钮。点击后等待离开目标 `/c/<conversationId>`，刷新侧栏并确认目标链接消失；随后重新导航到原 canonical URL，重新确认页面仍绑定原 `conversationId` 且目标 conversation turn 可定位，才返回成功。恢复后后续 `send` 与 `wait` 必须继续使用同一绑定。
- 浏览器重建只在确认原 named session 不存在后进行，再使用同一 `taskId`、session name 和 seed 创建新内存 context。未绑定 conversation 时只恢复唯一 `chatgpt-pro-collab` Project 的空白 composer 及固定模型与 Power；已经绑定时只打开记录的 canonical URL，并要求 URL、conversation identity 与已记录相关 turn 一致。`unknown-submission` 且没有 canonical identity 时不得猜测目标 conversation。
- `status` 只调用固定版本 CLI 的全局 `list` 并精确匹配已记录 session name，不执行 `open`、`goto`、`run-code` 或页面读取；唯一匹配为 `available`，确定无匹配为 `missing`，CLI 失败或输出无法解析为 `unknown` 并附带真实错误。
- Playwright session 自身是浏览器生命周期事实来源；SQLite 记录稳定 session name、已观察到的可用性、conversation identity、重建证据与 `closing` 意图，但不伪造浏览器仍存活。

### 命令与结果合同

| 命令                 | 必要输入                                                                            | 成功结果                                                                                     | 主要失败                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `setup`              | 无                                                                                  | 认证源已建立，设置浏览器已关闭                                                               | 用户未完成登录；认证源无法生成或验证；中断清理仍未完成                                  |
| `start`              | 调用方提供的稳定 `taskId`                                                           | 已确认目标 Project、`GPT-5.6 Sol + Power 5/5` 和新 conversation composer 后返回同一 `taskId` | 未 setup；身份冲突；认证源或浏览器失败；Project、固定模型、Power 或页面合同无法确认     |
| `send`               | `taskId`、`promptPath`、零或多个 `attachmentPath`                                   | 消息已提交并返回 `turnId`                                                                    | task 非活动；本 task 已有未完成 turn；输入不可读；上传失败；提交结果不明                |
| `wait`               | `taskId`、`turnId`、有限正整数 `observationWindowMs`、有限正整数 `captureTimeoutMs` | `status: pending`；或 `status: completed`、`responsePath`、按顺序排列的 `artifactPaths`      | 标识不存在；浏览器不可恢复；Web 状态无法判断；捕获超时；文字或文件捕获失败              |
| `status`             | `taskId`                                                                            | 返回持久状态、browser 可用性、未完成 operation、证据、错误与 `nextAction`                    | task 不存在；状态存储不可读                                                             |
| `recover`            | `taskId`                                                                            | 恢复到可安全继续的既有命令入口，并返回 `nextAction`                                          | 页面后置条件无法取得；conversation 无权访问或身份不符；需要人工提交裁决                 |
| `resolve-submission` | `taskId`、`turnId`、`submitted`、canonical `conversationUrl`                        | 页面验证并绑定原 turn，返回 `status: pending`                                                | 非 `unknown-submission`；conversation、prompt、附件或唯一 user turn 无法验证            |
| `resolve-submission` | `taskId`、`turnId`、`not-submitted`                                                 | 页面验证安全 composer，把原 turn置为 `failed`                                                | 非 `unknown-submission`；页面仍有匹配提交、不是目标 Project composer 或无法验证安全状态 |
| `close`              | `taskId`                                                                            | 本地任务已关闭                                                                               | 清理未完成时返回具体残留，不声称完整成功                                                |
| `archive`            | 活动 `taskId`                                                                       | 指定 Web conversation 已归档，task 页面已恢复原绑定                                          | task 非活动；conversation 尚未建立；Web 后置条件无法判断                                |

`start` 的命令形式为 `start <taskId>`，`taskId` 必须是 canonical lowercase UUID v4；CLI 在打开数据库、创建目录或调用浏览器前拒绝其他格式。`wait` 的命令形式为 `wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>`；人工裁决只允许 `resolve-submission <taskId> <turnId> submitted <conversationUrl>` 或 `resolve-submission <taskId> <turnId> not-submitted`。`conversationUrl` 必须由 URL parser 验证为无用户名、密码、query 和 fragment 的 `https://chatgpt.com/c/<conversationId>` canonical URL，其他 origin 或路径在浏览器动作前拒绝。`status` 的 `nextAction` 只允许 `setup | start | send | wait | recover | resolve-submission | close | none`。`pending` 是本次有限观察正常到期的成功结果，不是 turn 失败；捕获超时使用错误码 `CAPTURE_TIMEOUT`。完成结果和 pending 结果都包含 `taskId` 与 `turnId`。CLI 在一次调用中不得输出进度 JSON，错误只通过现有非零退出码与单条错误 JSON 返回。

安装后的 Skill 以加载到的 `SKILL.md` 所在绝对目录定位 CLI，保持宿主项目为当前工作目录，并调用 `node "<skill-directory>/scripts/collab.ts" <command>`；不得要求宿主项目提供 `package.json` 或 `collab` package script。源码仓库保留 `"collab": "node skills/chatgpt-pro-collab/scripts/collab.ts"` 作为开发入口，调用形式为 `pnpm collab -- <command>`，并提供 `"test": "vitest --run"` 供 VER-010 使用。命令不得要求宿主提供 repository root、branch、snapshot、bundle 或授权 token。

### 最小状态与数据布局

每个 task 只定义 `starting`、`active`、`closing`、`closed`、`failed` 五种状态；每个 turn 定义 `sending`、`pending`、`capturing`、`completed`、`failed` 和 `unknown-submission`。`starting` 表示调用方身份与启动意图已经持久化，但目标 composer 尚未完成后置条件确认；`closing` 表示关闭意图已经持久化，后续只能继续 `close`，不能重建 browser。`pending` 表示提交已成功，但尚未取得完整 Copy response 与有序 artifact 描述并原子建立 `capturing` 边界；它是本地持久化阶段，不等同于 Pro 必然仍在生成。`capturing` 表示原始 response 路径与完整 artifact 集已经冻结，后续只允许发布或核对原始文字并下载返回文件，不能再返回成功的 `pending` 结果。`unknown-submission` 只用于浏览器在提交边界失败、实现无法证明消息是否已经发送的真实歧义，不能被自动重试掩盖。

```text
~/.local/chatgpt-pro-collab/
├── state.sqlite                     # 协调状态与文件索引
├── auth/
│   └── seed.json                     # setup 保存的共享只读认证源
└── sessions/
    └── <taskId>/
        ├── playwright/               # 当前 task 的 CLI 输出与临时 run-code 文件
        └── turns/
            └── <turnId>/
                ├── prompt.md         # 发送前复制，后续不覆盖
                ├── response.md       # capturing 事务后发布，可暂不存在，后续不覆盖
                └── artifacts/
                    └── <ordinal>/
                        └── <filename> # 返回文件；ordinal 防止同名覆盖
```

发送附件只从宿主提供的原路径上传，并在 SQLite turn 记录中保存有序绝对路径，不复制到 session 目录。返回文件保存在 turn 目录并由 artifact 记录关联。这个 transcript 能审计文字交互、发送时选择的路径与返回文件字节，但不承诺在原发送附件被修改或删除后复原其字节。

### SQLite 合同

SQLite 只保存协调状态和文件索引，不保存 prompt、response 或返回文件正文。目标 schema 包含四张表：

| 表          | 主键                        | 必要字段                                                                                                                                                                       |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task`      | `id`                        | `playwright_session`、`conversation_id`、`conversation_url`、`status`、browser-operation lease 字段、`created_at`、`updated_at`、`closed_at`                                   |
| `turn`      | `task_id, id`               | `status`、`prompt_path`、`attachments_json`、可空 `user_turn_identity`、`response_path`、`error`、`created_at`、`updated_at`                                                   |
| `artifact`  | `task_id, turn_id, ordinal` | `source_url`、`label`、`filename`、`local_path`、`status`、`error`、`created_at`、`updated_at`                                                                                 |
| `operation` | `id`                        | `kind`、`step`、`phase`、`progress`、可空 `task_id`、可空 `turn_id`、`session_name`、`evidence_json`、`resolution_source`、`error`、`created_at`、`updated_at`、`committed_at` |

`task.status` 只允许 `starting | active | closing | closed | failed`；`turn.status` 只允许 `sending | pending | capturing | completed | failed | unknown-submission`；`artifact.status` 只允许 `pending | completed`。`pending`、`capturing` 和 `completed` turn 必须有唯一 `user_turn_identity`，其他状态允许为空。`operation.kind` 只允许 `setup | start | send | archive`；`step` 按 kind 只允许 `setup: login | seed | cleanup`、`start: session | project | configuration`、`send: draft | submit`、`archive: archive | restore`；`progress` 是当前 step 已验证的非负序号。`operation.phase` 只允许 `prepared | effect-unknown | needs-decision | committed`，`resolution_source` 只允许空值、`automatic` 或 `human`。`turn.task_id` 与 artifact 的 task/turn 组合使用外键关联，session name 唯一，单个 turn 的 `source_url` 唯一；每个 task 同时最多一个未 `committed` operation，全局同时最多一个未 `committed` setup operation。所有时间使用 ISO 8601 UTC 字符串；附件数组和 evidence 按稳定 schema 编码为 JSON 字符串。

`evidence_json` 只记录实际观察，不记录推断为事实；公共字段为 `observedAt`、`sessionName`、可空 `pageUrl` 和 `postcondition`。setup evidence 另含 `seedValidated` 与 `sessionClosed`；start evidence 另含 Project identity、模型与 Power；send evidence 另含可空 conversation identity、可空 user turn identity、prompt 是否逐字匹配和有序附件名称匹配结果；archive evidence 另含 conversation identity、`archived` 与 `bindingRestored`。人工提交裁决另记录 `decision`、用户提供的 canonical URL 和页面验证结果；不在 evidence 中复制 prompt 正文、附件字节、cookie 或 storage state。

每个 CLI 进程使用自己的 `DatabaseSync` 连接，并设置 `foreign_keys=ON`、WAL journal 和有限 busy timeout。会影响状态门或外部副作用归属的变更在 `BEGIN IMMEDIATE` 事务中完成；业务代码不得依赖进程内全局状态代替数据库约束。

`setup` 在打开 session 前创建全局 `setup: login: prepared` operation。`start` 在一个事务中创建 `starting` task 与 `start: session: prepared` operation；已存在且仍处于启动范围内的 taskId 只能进入同一任务恢复，其他状态返回冲突。`archive` 在点击前把已绑定 canonical identity 写入 `archive: archive: prepared` operation。上述意图未成功持久化时不得放行对应浏览器 command。

`send` 先在一个事务中创建 `sending` turn 与 `send: draft: prepared` operation，再无覆盖地发布 prompt 副本；prompt 缺失或不一致时不得执行浏览器动作，恢复把原 turn 置为 `failed`。turn 在证明提交完成前保持 `sending`。提交 command PID 放行前，operation 必须进入 `send: submit: effect-unknown`；页面自动证明提交或经过 BEH-013 的 `submitted` 裁决后，单个事务把 turn 置为 `pending`，记录唯一 user DOM identity，绑定 canonical conversation identity，并把 operation 置为 `committed`。`not-submitted` 裁决把 turn 置为 `failed` 后提交 operation。观察到网页完成后，turn 在取得 Copy response 与完整有序 artifact 描述期间仍保持 `pending`；超时、中断或浏览器错误不得留下 response 路径或部分 artifact 行。取得全部数据后，单个 `BEGIN IMMEDIATE` 事务必须同时把 turn 从 `pending` 置为 `capturing`、记录确定的 `response_path`，并按页面顺序建立全部 artifact 行；事务只能全部提交或全部回滚，不得把 `beginCapture` 与 artifact 建行拆成两个事务。事务提交后才发布 `response.md` 和返回文件。每个文件先写同目录临时文件，再无覆盖地发布到最终路径并标为 completed。只有 response 和全部 artifact 文件均可读时，turn 才能进入 `completed`。

### 浏览器副作用恢复

operation journal 只承载可能因进程退出而丢失确认的浏览器副作用，不复制 `wait` 的 capture 状态机或幂等 `close`。每个 operation 先保存 kind、当前 step、已验证 progress 与 `prepared`；实际浏览器 command 放行前写入 `effect-unknown`；取得该 step 的可验证后置条件后，推进下一个 `prepared` step，或在同一事务提交对应 task 或 turn 状态、证据、`resolution_source` 和 `committed`。自动判定无法得到唯一结论时，只有 `send: submit` 可进入 `needs-decision`；其他操作保留 `effect-unknown` 并在页面证据重新可用后恢复，不能让用户用无页面验证的声明代替系统状态。

| 中断状态                                          | 恢复动作                                                                                                                                                                                  | 禁止或失败处理                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| setup operation 为 `prepared`                     | 重新进入登录或 seed 保存；已有 seed 必须先验证                                                                                                                                            | 不把文件存在等同于认证有效                                                            |
| setup operation 为 `effect-unknown`               | 核对 seed；有效则只关闭记录的 setup session 并提交，无效则回到登录流程                                                                                                                    | 不删除有效 seed，不要求已完成登录的用户重复登录                                       |
| task 为 `starting`，start operation 未提交        | 使用同一 `taskId` 与 session name 核对 session；缺失时从 seed 重建，再验证 Project、composer、模型和模式                                                                                  | 不创建第二个 task、session identity 或 conversation                                   |
| send operation 的 step 为 `draft`                 | 清理或重建目标 composer；确认安全后把原 turn 置为 `failed` 并提交 operation，返回 `nextAction: send`                                                                                      | 不继续上传，不提交消息，不保留残留或重复附件；新的消息必须由宿主显式再次 `send`       |
| send operation 为 `send: submit: effect-unknown`  | 在已绑定 conversation 或唯一目标 Project 中可识别的新 conversation 中，从已记录前一 turn 锚点之后查找与保存的 prompt 及有序附件名称一致的唯一 user turn；唯一匹配时自动绑定并置 `pending` | 零个或多个候选、无 canonical identity 或证据不完整时进入 `needs-decision`，不自动重发 |
| browser session 不存在且 task 已绑定 conversation | 从 seed 重建相同 named session，打开记录的 canonical URL，核对 conversation identity 与相关 turn                                                                                          | 无权访问、目标缺失或身份不符时保持不可继续状态，不迁移 conversation                   |
| browser session 不存在且 task 未绑定 conversation | 从 seed 重建相同 named session，只恢复固定 Project 的空白 composer、模型和模式                                                                                                            | `unknown-submission` 不得走本分支猜测未提交                                           |
| archive operation 为 `effect-unknown`             | 重建或复用 session，核对目标是否已归档；已归档时恢复 canonical 绑定并提交，证明确未归档时重试一次归档流程                                                                                 | 后置条件不可得或相互冲突时保持原状态，不重复点击                                      |

首个 turn 的前一 turn 锚点是 conversation 起点，匹配候选必须是该 conversation 的第一个 user turn；后续 turn 使用已持久化的前一 completed turn identity 作为锚点。恢复不得只凭全文搜索在 conversation 的其他位置接受相同 prompt。

`status` 不取得 mutating operation lease，也不执行本表动作；它对同一数据库快照返回 `taskId`、`taskStatus`、可空 `turnId`、可空 `turnStatus`、`browserStatus: available | missing | unknown`、可空 `operationKind`、可空 `operationStep`、可空 `operationPhase`、可空 `operationProgress`、最近 evidence、最近 error 和唯一 `nextAction`。`nextAction` 表示继续或解除当前持久工作流的系统选定动作，不枚举 `close` 等调用方仍可主动选择的其他命令；没有待继续或待解除状态时为 `none`。`recover` 取得 lease 后只执行表中与当前持久状态匹配的一个恢复路径，并返回恢复后的同一组状态字段；若下一步是 `wait`、`close` 或人工裁决，只返回该 `nextAction`，不代替对应命令。

`close` 在关闭浏览器前以事务把任一非 `closed` task 置为 `closing`；`closing` task 的 `status.nextAction` 固定为 `close`，`recover` 不得重建其 browser。后续 `close` 只核对或终止记录的 named session，并在确认 session 不存在后把 task 置为 `closed`；状态写入失败时保持 `closing`，不得删除 transcript 或改回先前状态。

### 捕获提交与中断恢复

文件系统与 SQLite 不能组成一个原子事务。每次 `wait` 在继续 `capturing` turn 前必须按下表核对；恢复只复用或补齐同一目标 assistant turn 的结果，不删除、覆盖或猜测已有文件。

| 持久状态                                  | 恢复动作                                                                                                                        | 不一致处理                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pending`                                 | 重新检查目标 assistant turn；网页完成后重新取得 Copy response 与完整有序 artifact 描述，再按上一节建立一次完整 `capturing` 事务 | 捕获超时返回 `CAPTURE_TIMEOUT`，其他 Web 错误保留原码；均保持 `pending` |
| `capturing` 且 `response.md` 不存在       | 从同一目标 assistant turn 重新取得 Copy response，并无覆盖地发布到已记录的 `response_path`                                      | 无法重新取得原始回复时返回真实错误，保持 `capturing`                    |
| `capturing` 且 `response.md` 已存在       | 重新取得 Copy response 并逐字节比较；相同时复用现有文件                                                                         | 内容不同时返回 `TRANSCRIPT_INCONSISTENT`                                |
| artifact 为 `pending` 且最终文件不存在    | 重新建立目标 turn 的页面映射，按该行 `source_url` 触发下载到同目录临时文件，无覆盖地发布后标为 `completed`                      | 下载或发布失败时记录该行错误，turn 保持 `capturing`                     |
| artifact 为 `pending` 但最终文件已经存在  | 重新建立页面映射并按 `source_url` 下载到临时文件，与现有最终文件逐字节比较；相同时复用现有文件                                  | 内容不同时返回 `ARTIFACT_INCONSISTENT`，不得覆盖现有文件                |
| artifact 为 `completed`                   | 验证 `local_path` 对应文件可读后直接复用                                                                                        | 文件缺失或不可读时返回 `ARTIFACT_INCONSISTENT`                          |
| response 与全部 artifact 均满足完成不变量 | 在事务中把 turn 从 `capturing` 置为 `completed`                                                                                 | 状态或文件在提交前变化时返回冲突，由下一次 `wait` 重新核对              |

每次重新取得 `capturing` 目标 turn 时，页面发现的有序唯一 `source_url` 列表必须与已记录 artifact 行一致；不一致时返回 `ARTIFACT_SET_INCONSISTENT`。原子边界前的捕获超时、中断或错误保持 `pending` 且不能留下半冻结状态；原子边界后的捕获超时、中断或上述错误都不把 `capturing` 改回 `pending` 或改成 `completed`。数据库损坏时返回真实错误，不自动删除 transcript 或伪造成功状态。

### 顺序、并发与幂等

- 同一 task 的 CLI 调用通过 SQLite 状态门和同一个 Playwright named session 排序；不同 task 使用不同 named session、浏览器进程、browser context 和 turn 目录。
- `start`、`send`、`archive`、`recover` 和 `resolve-submission` 共享同一 task operation lease；对同一 `taskId` 的重复或并发 `start` 只能观察或继续同一个 `starting` task。
- `send` 先写入 turn 标识、prompt 副本与 operation，再进行浏览器副作用；只有确认消息已提交后才返回成功。提交结果不明确时记录 `unknown-submission` 和 `needs-decision`，不自动重发。
- `wait` 的内部页面检查、operation lease 释放和再次检查都不写宿主可见进度；网页未报告完成且达到观察 deadline 后才返回一次 pending。网页已报告完成但捕获在原子边界前失败时返回真实错误并保持持久状态 `pending`；后续重试仍重新观察目标 turn 并重取 Copy。turn 进入 `capturing` 后，重试跳过生成等待，先执行捕获恢复核对，再复用已完成 artifact 并只下载未完成项。
- completed turn 的 `wait` 是幂等读取；`close` 是幂等清理。`archive` 依赖 Web 端实际状态，只有观察到指定 conversation 已归档且 task 页面恢复原绑定才返回成功。
- 观察窗口不会关闭 task 或取消远端生成。调用环境中断时，持久 task、turn、operation 和 transcript 继续存在；Playwright session 仍在时复用，已经退出时按 BEH-013 重建。
- 回复捕获不得依赖未经隔离验证的全局剪贴板。若驱动必须使用 Copy 控件，VER-004 和 VER-006 必须证明并发任务不会读到彼此内容。

### 失败与运行边界

- 输入路径、归档生成、浏览器动作、返回文件下载或本地写入失败时返回具体操作和原因；不得把失败记为 completed，也不得因为失败扫描更多本地文件。
- 不进行自动 prompt 重发或 conversation 迁移。Playwright session 只能由 `start` 重试或 `recover` 按已记录的 seed、`taskId`、固定 Project 和 canonical identity 重建；普通 `send`、`wait` 或 `archive` 不得静默切换到新 session 或其他 conversation。
- BEH-008 的进程终止出现部分失败时，保留可定位的进程或 session 信息并返回失败；不删除 transcript 来伪造清理完成。
- task 和 turn 标识必须不可碰撞；prompt、response 和返回文件写入先落到同目录临时文件，再无覆盖地发布各自目标文件。已经发布的文件不再覆盖；相同 `sandbox:` 目标只关联一个本地文件。
- Pro 与本地 Agent 是受信任的协作方。Collab 对返回文件只承担保存职责，不自动解压、预览、执行、应用 patch 或修改权限；这些动作由宿主在 `wait` 返回后按任务需要决定。
- `browser.ts` 是 ChatGPT Web 易变接口的唯一承载层。selector、完成检测、Copy response、`sandbox:` 文件发现与下载和 Archive 必须在固定 Playwright CLI 版本与 live 环境中验证后才能视为已实现。

## 验收与验证

### VER-001 共享认证源

- **覆盖对象**：BEH-001。
- **前置条件**：可交互登录的 Pro 账号、干净认证目录，以及满足 BEH-002 启动前提的现有 Project、模型与 Power 控件。
- **执行或检查**：使用固定 Playwright CLI 登录并 `state-save`；分别在 seed 发布前、seed 验证后但 setup session 关闭前终止进程，再执行 `setup`；最后从同一 seed state 同时执行 `start task-a` 与 `start task-b`。
- **通过证据**：seed 发布前中断不产生成功认证状态；seed 验证后的重试不要求重复登录，只关闭记录的 setup session；两个非持久 task session 均已登录且未再次请求登录；seed 文件未被 task 改写。
- **证明边界**：不证明认证长期不过期。
- **必需性**：必需。

### VER-002 独立任务启动

- **覆盖对象**：BEH-002。
- **前置条件**：VER-001 通过；账号中恰有一个现有 Project 精确命名为 `chatgpt-pro-collab`，并可使用 `GPT-5.6 Sol` 模型与五级 Power slider。
- **执行或检查**：调用方生成两个 canonical lowercase UUID v4，并同时启动；对每个任务检查 Project URL、主区域 Project 标题、空白 composer、user turn 数量、模型回读、Power slider 数值状态、Playwright session、浏览器进程、browser context 和 session 目录，再分别完成首次发送。对第一个 `taskId` 在绑定 conversation 前并发重复 `start`，并分别在 task 事务提交后、session 打开后、seed 加载后、Project 导航后和固定模型与 Power 回读前后终止进程，再以同一 `taskId` 重试；绑定 conversation 后再次 `start`。确定性夹具另覆盖大小写错误、非 UUID、路径分隔符与 closing、closed、failed taskId，并从非目标模型与非最大 Power 开始，分别覆盖 Project 缺失、同名 Project 不唯一、固定模型或 Power 缺失、操作后无法回读目标状态以及页面合同漂移。
- **通过证据**：两个任务都只在唯一 `chatgpt-pro-collab` Project 的空白 composer 中返回成功，每次 `start` 成功时 user turn 数量都为零，当前模型均为 `GPT-5.6 Sol`，唯一 Power slider 均满足 `aria-valuenow == aria-valuemax == 4`，并由零基 `0..4` 值域证明当前处于第五级（`5/5`）；两个不同 task 具有不同 named session、浏览器 PID、内存 browser context、taskId、session 路径和 Project 内 conversation。相同 `taskId` 的并发与中断重试只有一条 task 记录、一个稳定 session identity 和一个 composer，不分配新 taskId。非法、已绑定 conversation 或已终结的 taskId 在目录或浏览器副作用前被拒绝；其他确定失败夹具返回对应错误，不产生成功结果，`failed` task 记录保留，且没有调用 Project 创建或修改操作。
- **证明边界**：不证明消息并发、回复隔离、其他账号权限或未来 ChatGPT Web 页面结构。
- **必需性**：必需。

### VER-003 显式输入边界

- **覆盖对象**：BEH-003 与产品边界。
- **前置条件**：新启动的活动任务；当前目录含 dirty Git 状态、未指定文件和 symlink；输入选择层使用可观察或可注入的文件访问边界。
- **执行或检查**：宿主先把 Skill 中的固定协作合同与当前任务写入同一 prompt 文件，再从工作区内外各选择明确的普通附件执行首次 `send`，记录输入选择层的路径解析、文件访问和读取调用；另以 live Web 检查 user turn 文字与实际上传项，不传入其他文件。分别在每个附件上传后且提交 command 放行前终止进程，再执行 `recover` 并重新进入显式 send 流程。
- **通过证据**：首个 user turn 与指定 prompt 文件逐字一致，在一条消息内完整包含一份固定协作合同和当前任务，且没有独立启动 user turn。Pro 的第一个回复直接处理当前任务，或在真正阻塞时提出一个聚焦问题，不只确认协作模式。输入选择层只解析和访问指定 prompt 与附件；显式外部路径可上传；Web 没有未指定上传项或归档；正常路径返回 turnId。提交放行前的每个中断点都恢复为没有残留或重复附件的安全 composer，原 turn 标为 `failed`，未产生 user turn，也未自动发送；新的消息只有在宿主再次显式 `send` 后出现，且其 prompt 仍包含完整协作合同。
- **证明边界**：不约束 Node.js、npm/npx、浏览器或操作系统读取其运行依赖、配置与缓存；不证明归档输入或 Pro 回复正确。
- **必需性**：必需。

### VER-004 原始文字捕获

- **覆盖对象**：BEH-004。
- **前置条件**：已发送包含长文本与代码块、可产生无文件回复的 turn。
- **执行或检查**：使用足够的观察窗口与捕获超时执行 `wait`；检查持久化 user identity、目标 assistant、`Stop answering` 与 Copy 状态，将页面内 Copy response 和 `response.md` 逐字节比较，再重复 wait。自动化 fixture 另覆盖目标 user 之后出现额外 user turn、observation 已判定 T1 完成但 capture 前页面新增 T2 的竞态，以及 Stop 持续可见的观察到期路径；正常捕获 fixture 必须真实执行页面内 clipboard install→Copy click/write→captured read→restore。
- **通过证据**：正常路径返回 completed，内容一致，没有读取系统剪贴板，artifactPaths 为空，重复调用返回同一路径且旧 response 未覆盖；wait 只使用持久化 user identity，target 缺失或不唯一时不退回 latest user。observation 返回的 T1 identity 被显式传给 capture，页面新增 T2 时 capture 仍只接受 T1，T1 缺失或不唯一时不点击 Copy、不进入 `capturing`；Stop 持续可见时不点击 Stop、不 reload，并在观察窗口到期后返回 pending。页面内 clipboard fixture 逐字验证 `text/plain`、`text/html` 和失败/成功路径的全局恢复。
- **证明边界**：不覆盖返回文件下载、其他未知 ChatGPT Web 加载指示漂移或用户主动刷新。
- **必需性**：必需。

### VER-005 同一任务多轮

- **覆盖对象**：BEH-005。
- **前置条件**：同一 task 的首个 turn 已完成。
- **执行或检查**：发送不重复固定协作合同、但引用上文的第二个 prompt 并等待。
- **通过证据**：conversation 标识不变；第二个 user turn 不包含固定协作合同，回复仍使用首轮建立的协作上下文；两个 turn 文件独立。
- **证明边界**：不证明跨任务并发或 Archive 后恢复。
- **必需性**：必需。

### VER-006 多任务并发隔离

- **覆盖对象**：BEH-006。
- **前置条件**：VER-002 通过；两个任务可产生回复。
- **执行或检查**：对两个 named session 分别 send，不等待第一个完成即并发执行带观察窗口与捕获超时的 wait。
- **通过证据**：两个生成区间重叠；两份回复、artifact 索引与 transcript 分别归属正确 task；单边失败不停止另一边。
- **证明边界**：不证明任意任务规模下的吞吐。
- **必需性**：必需。

### VER-007 审计记录持久性

- **覆盖对象**：BEH-007、BEH-012、BEH-013。
- **前置条件**：至少两个 completed turn 使用过同名 prompt 和返回文件名。
- **执行或检查**：修改原 prompt 文件；检查 SQLite 与 turn 目录；对一个自动恢复和两个提交裁决分支检查 operation evidence 与 resolution source；关闭任务后用新的 CLI 进程复读。
- **通过证据**：task、turn、user turn identity、artifact 顺序和路径可查询；prompt、response、返回文件保持原内容；发送附件正文没有副本；自动恢复与人工裁决可区分，人工记录包含结论、页面 identity、时间和最终状态。
- **证明边界**：不保证已修改发送附件的字节级复原。
- **必需性**：必需。

### VER-008 本地任务关闭

- **覆盖对象**：BEH-008。
- **前置条件**：活动任务且 Web conversation 已建立。
- **执行或检查**：在浏览器关闭前、浏览器关闭后但 task 状态提交前分别终止 `close`，先执行 `status` 与 `recover`，再并发执行两次 `close`，检查 Playwright session、本地目录与 Web。
- **通过证据**：中断后 task 保持 `closing`，`status.nextAction` 为 `close`，`recover` 不重建 session；所有路径最终只有同一个 closed task，named session 和浏览器进程消失；SQLite、transcript、返回文件与共享 seed 保留；Web 未归档；重复调用无额外副作用。
- **证明边界**：不证明操作系统能清理被外部程序锁定的文件。
- **必需性**：必需。

### VER-009 Web conversation 归档与恢复

- **覆盖对象**：BEH-005、BEH-009。
- **前置条件**：活动任务且 Web conversation 已建立。
- **执行或检查**：正常执行 `archive`，等待离开目标 canonical URL，刷新侧栏并确认归档；随后检查恢复后的页面绑定，再在同一 task 执行一次 send/wait。另分别在 operation 准备后、Archive command 放行后、Web 已归档但本地未提交以及 canonical 页面恢复前终止进程，执行 `status` 与 `recover`；页面夹具覆盖“已归档”“证明确未归档”和后置条件不可得。
- **通过证据**：刷新后目标 conversation 不在侧栏；页面恢复到原 `/c/<conversationId>` 且原 turn 可定位；后续 send/wait 仍使用相同 conversation 标识；进程和 transcript 保持；其他 conversation 不变。`status` 不改变页面；已归档路径不再点击 Archive，证明确未归档路径只重试一次归档流程，证据不可得时保持 `effect-unknown` 且不点击。
- **证明边界**：只覆盖当次 ChatGPT Web Archive 与 canonical URL 恢复界面。
- **必需性**：必需。

### VER-010 确定性实现检查

- **覆盖对象**：BEH-001–BEH-013 的确定性实现。
- **前置条件**：依赖已安装，目标代码和测试存在。
- **执行或检查**：在最后一次相关修改后运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm collab -- help`；从无 `package.json` 的临时宿主目录用绝对路径执行 Skill CLI `help`。
- **通过证据**：每条命令退出码为 0；入口不依赖宿主 package manifest；help 含稳定 taskId、两个 wait 时长参数、`status`、`recover` 与两个 `resolve-submission` 形式；测试输出可追溯对应 `BEH-*`。
- **证明边界**：不证明真实 ChatGPT Web 或用户主动中断行为。
- **必需性**：必需。

### VER-011 中断恢复与并发状态

- **覆盖对象**：BEH-001–BEH-004、BEH-006–BEH-009、BEH-012、BEH-013。
- **前置条件**：state 与文件存储实现及测试存在。
- **执行或检查**：以多进程覆盖相同与不同 task，在每种 operation 的 `prepared`、command 放行前、`effect-unknown`、业务状态提交前后终止进程；验证单 task 未提交 operation 唯一约束、lease orphan 回收和旧 command PID fencing。另分别在原子 capturing 事务提交前、事务提交后、response 发布后、artifact 发布但状态更新前、部分 artifact 完成后终止进程；重开数据库并执行两张恢复矩阵，最后并发 close。
- **通过证据**：operation 与 task/turn 状态只按规定事务组合出现；同 task 不存在两个未提交 operation，旧 owner 或 command 不能越过新 lease 产生副作用，不同 task 无跨任务污染。capturing 事务提交前的中断只保留完整 `pending`，提交后一次可见 `capturing`、response_path 与全部 artifact 行；各后续中断点都能复用或补齐一致内容；不一致使用规定错误码；文件无覆盖；completed 不变量保持；重启后可继续。
- **证明边界**：不证明浏览器、下载或 ChatGPT Web 行为。
- **必需性**：必需。

### VER-012 运行前提

- **覆盖对象**：BEH-001–BEH-013 的运行前提。
- **前置条件**：Node.js v22.19.0、当前受支持 Node、npm/npx 和网络可用。
- **执行或检查**：分别在最低与当前 Node 执行版本检查、`node:sqlite` DatabaseSync 内存库 smoke test 和最小 `.ts` 入口 smoke test；执行固定 Playwright CLI help 与无 browser 的 raw `list`。
- **通过证据**：两个 Node 版本的 smoke test、`npx -y @playwright/cli@0.1.17 --help` 与 `npx -y @playwright/cli@0.1.17 --raw list` 退出码均为 0，list 结果可确定表达当前没有 browser。
- **证明边界**：不证明登录、storage state、页面 selector 或归档工具。
- **必需性**：必需。

### VER-013 输入归档 forward test

- **覆盖对象**：BEH-010。
- **前置条件**：可加载 Skill 的宿主 Agent、能生成两种归档的环境与活动 Pro 任务。
- **执行或检查**：对同一份含至少 100 个已选代码文件且在支持时带宿主 xattr 的固定夹具运行两个宿主 Agent forward test。任务 A 不指定格式；任务 B 只说明接收端是不能假定提供 tar 工具的跨平台环境，不直接指定归档格式。记录 Agent 生成参数、成员与元数据核对、send 参数、Web 上传项和 Pro 解压 marker。
- **通过证据**：任务 A 自动生成一个不含宿主扩展属性的 `.tar.gz` 附件；任务 B 自动生成一个 `.zip` 附件；两者只含所选 regular file 与必要目录项、各占一个上传项，且 Pro 解压后的文件数、全部 marker 和内容摘要均与本地一致。
- **证明边界**：不证明其他提示、操作系统工具、文件大小或压缩算法。
- **必需性**：必需。

### VER-014 单次等待调用

- **覆盖对象**：BEH-011。
- **前置条件**：可加载 Skill 的宿主 Agent、可控制页面检查次数与终态的浏览器夹具。
- **执行或检查**：分别制造“内部多次检查后完成”“观察窗口到期”“捕获超时”“其他真实浏览器错误”，让宿主 Agent 对每个场景执行等待，并记录 Skill 命令、CLI 进程、页面检查及 stdout/stderr。
- **通过证据**：每个场景只启动一次 `wait`；终态前 stdout/stderr 无应用进度；内部页面检查可发生多次；结束时恰有一条 completed、pending 或 error 终态 JSON，且 Agent 未重复调用 `wait` 或另行轮询浏览器。
- **证明边界**：不证明用户主动中断后的外部调度行为。
- **必需性**：必需。

### VER-015 返回文件捕获

- **覆盖对象**：BEH-004、BEH-012。
- **前置条件**：Live Pro 能生成含 sandbox 文件链接的目标回复。
- **执行或检查**：让目标 turn 返回 HTML、ZIP、图片、源码、两个同名文件、重复 sandbox 目标和普通 HTTPS 链接；执行带两个时长的 wait，核对 Copy response 的两种 ClipboardItem 类型、sandbox occurrence 与正文按钮的顺序、artifact 子序列、直接与 artifact download event 以及落盘文件；另用确定性故障注入覆盖下载控件被滚动容器遮挡、页面数量或顺序漂移、部分下载失败、原子边界前后捕获超时、重试及下载跨过观察 deadline。
- **通过证据**：Copy response 原样保存；唯一 sandbox 文件按顺序落盘；重复项只下载一次；同名目标以逻辑 URL 区分且本地文件不覆盖；HTTPS 未下载；直接与 artifact 页面路径均成功产生对应 download event，控件被遮挡时仍通过已验证的目标控件触发下载；页面映射不一致时返回页面合同漂移；原子边界前捕获超时返回 `CAPTURE_TIMEOUT` 且保持完整 `pending`，边界后捕获超时返回同一码并保持 `capturing`；deadline 前的真实浏览器错误保留原码；重试分别重取 Copy 或复用已冻结内容并完成；不因观察 deadline 返回成功的 pending。
- **证明边界**：只覆盖当次 ChatGPT Web 文件 UI 与注入的下载失败路径。
- **必需性**：必需。

### VER-016 端到端恢复与提交裁决

- **覆盖对象**：BEH-002、BEH-003、BEH-005–BEH-009、BEH-013。
- **前置条件**：有效 seed、可建立 conversation 的 Live Pro 账号、可终止 task browser 与 CLI command 的测试驱动，以及能呈现唯一、零个和多个匹配 user turn 的确定性页面夹具。
- **执行或检查**：先证明 `status` 对活动、browser 缺失、operation 未完成和 `needs-decision` 状态只读。随后分别终止尚未首次发送的 task browser、已经绑定 conversation 且 turn 为 pending 的 task browser，以及提交 command 已放行但首次 conversation identity 尚未持久化的 browser；对前两者执行并发 `recover`，对第三者检查阻塞。另制造提交返回丢失但页面保留唯一匹配 user turn 的自动恢复、零个或多个候选的阻塞、携带正确或错误 canonical URL 的 `submitted` 裁决，以及用户给出 `not-submitted` 但页面分别处于安全 composer、有匹配提交或错误 Project 的场景。每个场景记录 browser command、页面 identity、operation transition、turn transition 和 user turn 数量。
- **通过证据**：`status` 前后数据库与页面无变化；未绑定 task 只恢复同一 `taskId` 的固定 Project composer，已绑定 task 只恢复同一 canonical conversation 与相关 turn，两个并发 `recover` 只创建一个有效 named session。唯一页面匹配可自动置为 `pending` 且 user turn 总数不增加；无 canonical identity、零个或多个候选进入 `needs-decision` 且不发送。有效 `submitted` URL 只在固定 Project、既有 task 绑定、conversation、保存的 prompt、有序附件名称和唯一 user turn 全部匹配后绑定原 turn；有效 `not-submitted` 只在用户裁决且已绑定 conversation 或未绑定 Project composer 验证安全后把原 turn 置为 `failed`。错误 URL、输入不符、候选不唯一、有匹配提交、错误 Project、无权限和并发状态冲突均保持原状态；所有路径的自动或人工 resolution source 可审计，消息均不自动重发。
- **证明边界**：页面匹配只能证明当时可见的 conversation、prompt 和附件名称，不能证明远端附件字节；`not-submitted` 的历史事实来自用户裁决，页面只证明后续发送状态安全；不证明已删除或当前账号无权访问的 conversation 可恢复。
- **必需性**：必需。

VER-001–VER-016 均为完成本规格的必需验证。涉及真实 ChatGPT Web 的 VER-001–VER-009、VER-013、VER-015 和 VER-016 未经 live 执行，不得以 mock、单元测试或代码审查声称通过；VER-014 必须实际运行 Skill 与 CLI，并取得调用次数、页面检查和进程输出证据，不能只检查 Skill 文案或页面循环的单元测试。

Live 验证证据不提交仓库。涉及真实环境、人工执行或独立复审的验证记录（verification/review 报告与 live 脚本）保存在 `~/.local/chatgpt-pro-collab/verification/<日期-轮次>/`；该目录是仓库内 `VER-*` 判据之外的证据位置，只读引用，不作为本仓库内容。

**相关修改**是指改变任一 `VER-*` 的覆盖行为、组件映射、状态、接口、前置条件、执行步骤或证据判据的变更。全部必需 `VER-*` 必须在最后一次相关修改后重新通过；局部修复至少重跑失败的 `VER-*`、所有受影响的 `VER-*`、VER-010 和 VER-012；涉及 SQLite 状态时还必须重跑 VER-011。

执行前必须重新核对：采用的仍是本文件及其当前版本；阻塞未决事项已经解除；目标仓库中的运行版本、browser dependency、命令入口和测试入口与技术设计一致；工作区已有改动已识别且不会被覆盖或归入本次实现。

失败后按证据分流：实现偏离 `BEH-*` 时修复最小实现根因；测试与 `BEH-*` 冲突时只在直接证据支持下修订测试；ChatGPT Web、权限或环境不可用时记录失败动作和缺失前置，不修改产品代码伪造通过；外部接口或 checkout 漂移时重新取证，若漂移会改变产品行为则暂停并请求用户裁决。

没有新证据，且下一步不会引入新的可验证假设、证据来源或不同修复动作时，停止重复尝试。报告已尝试动作、现有证据、阻塞原因和解除条件；固定重试次数不能替代该判断。

完成条件是：所有 `BEH-*`、产品边界和不可接受结果均有验证覆盖；VER-001–VER-016 在最后一次相关修改后通过；本规格标记为需要直接检查的 SQLite、session 文件、浏览器进程、Playwright session、Web conversation、transcript、返回文件和 CLI 终态结果已实际检查；不存在阻塞未决事项；最终变更未加入仓库理解、返回产物自动集成或其他规格外能力。

## 决策记录

| 选择                                | 状态   | 理由                                                                                                                              | 影响                                                                                            |
| ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 轻量浏览器协作通道                  | 已确认 | 仓库理解、安全判断和代码集成不属于浏览器传输职责；核心只保留协作输入、浏览器操作和原始输出                                        | BEH-001–BEH-013、产品边界、技术设计                                                             |
| 每 task 独立浏览器进程              | 已确认 | 多任务必须能够同时等待和操作，不能由共享浏览器或串行控制互相影响                                                                  | BEH-002、BEH-006、VER-002、VER-006                                                              |
| 宿主显式提供输入                    | 已确认 | Collab 不可能可靠理解所有用户项目；文件与归档内容应由掌握任务上下文的宿主负责                                                     | BEH-003、BEH-010、产品边界、VER-003、VER-013                                                    |
| 首轮组合式协作合同                  | 已确认 | Pro 需要在开始有界任务时知道双方责任、可观察边界和协作方式；与当前任务一次提交可避免额外启动 turn，同时保留 prompt 逐字审计       | BEH-002、BEH-003、BEH-005、Skill entry、VER-002、VER-003、VER-005                               |
| send 与 wait 分离                   | 已确认 | Pro 可能长时间生成；提交不应占住宿主模型或阻止其他任务继续工作                                                                    | BEH-003、BEH-004、BEH-006、BEH-011                                                              |
| 一次 wait 只产生一个终态结果        | 已确认 | 让 Agent 反复检查会浪费 token；页面检查应由浏览器层承担，宿主只在完成、到期或真实错误时取得结果                                   | BEH-004、BEH-011、CLI、VER-014                                                                  |
| 生成观察与结果捕获使用独立时长      | 已确认 | 观察窗口只决定何时返回 pending；回复完成后仍需给整轮文件捕获一个独立、有限且可重试的执行窗口                                      | BEH-004、BEH-012、命令合同、VER-014、VER-015                                                    |
| capturing 以完整描述原子冻结为边界  | 已确认 | 网页完成观察不是可恢复的数据边界；response 路径与完整 artifact 集必须同时可见，边界前错误保持 pending                             | BEH-004、BEH-012、SQLite 合同、VER-011、VER-015                                                 |
| Stop 持续可见时不自动恢复           | 已确认 | 持续加载指示不能证明网页已经完成；自动 reload 或仅凭内容稳定捕获会引入错误目标和截断回复风险                                      | BEH-004、Playwright CLI 合同、VER-004                                                           |
| `.tar.gz` 默认、`.zip` 可选         | 已确认 | 归档用于避免上传大量分散文件；代码任务偏向 tar，跨平台或任务约定需要 zip，同时不固定协作协议                                      | BEH-010、输入归档合同、VER-013                                                                  |
| 原始回复与产物交给宿主解释          | 已确认 | 固定 response schema、diff 或 receipt 解析会写死协作方式；Pro 和宿主应按任务选择 patch、归档或文字                                | BEH-004、BEH-012、产品边界、VER-004、VER-015                                                    |
| 全部 sandbox 文件落盘后才 completed | 已确认 | 宿主被唤醒时应拿到可操作的完整结果；生成观察窗口不应截断已开始的文件捕获                                                          | BEH-004、BEH-012、capturing 状态、VER-011、VER-015                                              |
| close 与 Web archive 分离           | 已确认 | 本地进程生命周期与 Web conversation 生命周期是两种独立副作用，必须由不同显式命令触发                                              | BEH-008、BEH-009、VER-008、VER-009                                                              |
| Playwright CLI 浏览器边界           | 已确认 | 固定版本外部 CLI 提供 session、storage state 和页面命令；浏览器易变细节集中在单一边界（REF-001）                                  | Browser boundary、VER-001–VER-006、VER-008、VER-009、VER-012、VER-015                           |
| 共享只读 storage state              | 已确认 | 共享 seed 只提供启动认证数据；每 task 独立 browser context 承担运行时状态隔离，复制 seed 不增加隔离                               | BEH-001、BEH-002、BEH-006、VER-001、VER-002、VER-006                                            |
| SQLite 与正文/文件分离              | 已确认 | 结构化状态需要事务和跨进程恢复；文字与返回文件仍应直接可读、逐 turn 无覆盖                                                        | State store、Transcript/artifact store、VER-007、VER-011、VER-012                               |
| 调用方提供稳定 task identity        | 已确认 | `start` 中断或并发重试时只有调用方预先持有稳定身份，才能确定恢复同一任务而不是创建第二个浏览器与 composer                         | BEH-002、命令合同、SQLite 合同、VER-002、VER-016                                                |
| 证据优先的阶段恢复                  | 已确认 | 浏览器副作用可能在本地确认前已经发生；持久阶段与页面后置条件可以避免重复发送、重复归档和人工修改数据库                            | BEH-001–BEH-009、BEH-012、BEH-013、技术设计、VER-001–VER-003、VER-007–VER-012、VER-015、VER-016 |
| 页面验证的人工提交裁决              | 已确认 | Web 没有调用方可持有的提交幂等 receipt；自动证据不足时需要由用户补充历史事实，同时由页面验证约束可执行后果                        | BEH-003、BEH-007、BEH-013、命令合同、VER-007、VER-016                                           |
| 固定 GPT-5.6 Sol 与 Power 5/5       | 已确认 | 2026-08-07 live UI 已由旧 Pro radio 改为模型菜单与五级 Power slider；用户明确选择固定最高级，live 控件以零基 ARIA `0..4` 表示五档 | BEH-002、Playwright CLI 合同、命令合同、VER-001、VER-002                                        |

## 参考资料

| ID      | 名称                              | 位置                                                                  | 版本或日期         |
| ------- | --------------------------------- | --------------------------------------------------------------------- | ------------------ |
| REF-001 | Playwright CLI README             | https://github.com/microsoft/playwright-cli/blob/v0.1.17/README.md    | v0.1.17            |
| REF-002 | Node.js SQLite API                | https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html     | Node.js v22.19.0   |
| REF-003 | Node.js TypeScript type stripping | https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html | Node.js v22.19.0   |
| REF-004 | ChatGPT Web 返回文件页面 Spike    | `docs/spikes/2026-08-05-chatgpt-web-return-files.md`                  | 2026-08-05 live UI |
| REF-005 | ChatGPT Web Start 上下文 Spike    | `docs/spikes/2026-08-06-chatgpt-web-start-context.md`                 | 2026-08-06 live UI |
