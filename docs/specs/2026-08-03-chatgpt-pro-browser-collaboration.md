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
- **可观察行为**：Collab 打开一次交互式登录流程，并在用户完成登录后保留可供后续任务加载的本地认证源；`setup` 完成后关闭本次设置使用的浏览器。
- **验收条件**：完成一次人工登录后，两个后续任务都能在不再次要求用户登录的情况下进入已登录的 ChatGPT Web。
- **状态**：已确认。

### BEH-002 启动独立任务

- **触发与前置条件**：宿主执行 `start`，且 BEH-001 的认证源可用。
- **可观察行为**：Collab 返回唯一 `taskId`，为该任务创建独立浏览器进程、独立 browser context、独立会话目录和一张新的 ChatGPT 对话页面。首次成功发送时，任务固定绑定该页面建立的 conversation；任务只读加载 BEH-001 的认证源，不创建 task 认证状态副本。
- **验收条件**：任意两个活动任务具有不同的 `taskId`、浏览器进程、browser context 和会话目录，首次发送后具有不同 conversation；启动新任务不因同一项目或其他未关闭任务而拒绝。
- **状态**：已确认。

### BEH-003 发送明确输入

- **触发与前置条件**：宿主对活动任务执行 `send(taskId, promptPath, attachmentPaths[])`；该任务没有未完成 turn；所有传入路径均由宿主明确指定且当前可读。
- **可观察行为**：Collab 输入选择层只解析并读取 `promptPath` 与 `attachmentPaths` 中明确列出的文件，向该任务的 conversation 提交一次消息，随后立即返回唯一 `turnId`，不等待 Pro 完成回复。
- **验收条件**：输入选择层的文件访问记录只包含指定 prompt 和附件；Web 端收到的 prompt 与指定文件一致；未列出的仓库输入不会被该层枚举、打开、打包或上传；调用方在消息提交完成后取得 `turnId`。
- **状态**：已确认。

### BEH-004 等待并捕获原始回复

- **触发与前置条件**：宿主执行 `wait(taskId, turnId, observationWindowMs, captureTimeoutMs)`，该 turn 已提交，且两个时长都是宿主提供的有限正整数。
- **可观察行为**：Collab 在观察窗口内检查该 turn 的 Pro 回复。网页报告回复完成后，Collab 在本次 `captureTimeoutMs` 的宿主侧单调 deadline 内取得 Web 端完整 Copy response 与完整有序 artifact 描述，再以一个 SQLite 事务建立 `capturing` 边界；事务后把原始文字写入该 turn 专属且不覆盖其他 turn 的 `response.md`，并完成 BEH-012 的返回文件捕获。`observationWindowMs` 只约束网页完成观察；`captureTimeoutMs` 从网页报告完成或本次调用开始恢复 `capturing` turn 时计时，约束本次完整文字与剩余文件捕获。观察窗口到期而网页尚未报告完成时返回 `pending`；捕获超时或浏览器发生真实错误时返回错误。
- **验收条件**：`completed` 只在 `response.md` 与全部返回文件均已落盘后返回；`pending` 是已成功提交但尚未取得完整 Copy response 与 artifact 描述并建立原子 `capturing` 边界的本地持久化状态，不声称 Pro 必然仍在生成。取得完整数据前超时返回 `CAPTURE_TIMEOUT` 或发生其他真实错误时 turn 保持 `pending`，后续 `wait` 重新观察并重取 Copy；进入 `capturing` 后超时、中断或下载失败则保持 `capturing`，后续 `wait` 使用新的 `captureTimeoutMs` 按恢复矩阵继续。同一 completed turn 再次 `wait` 返回同一 `responsePath` 和文件路径；调用方中断不会停止远端生成，后续仍可再次 `wait`。
- **状态**：已确认。

### BEH-005 同一任务持续多轮

- **触发与前置条件**：前一 turn 已完成，任务仍活动。
- **可观察行为**：宿主可再次执行 BEH-003 和 BEH-004；所有 turn 继续使用同一个浏览器进程和同一个 conversation，并分别保存输入与回复。
- **验收条件**：后续回复能使用此前 conversation 的上下文；每个 turn 有独立 `turnId` 和文件记录；同一任务同一时间最多存在一个未完成 turn。
- **状态**：已确认。

### BEH-006 多任务真实并发且隔离

- **触发与前置条件**：至少两个任务处于活动状态。
- **可观察行为**：不同任务可同时执行上传、发送、等待和回复捕获；一个任务的长时间生成、失败或关闭不暂停其他任务。
- **验收条件**：任务 A 与任务 B 能在时间上重叠地等待 Pro 回复；各自的 prompt、附件、conversation、回复和 transcript 不交叉；实现不是用同一浏览器进程串行轮询来模拟并发。
- **状态**：已确认。

### BEH-007 保留逐 turn 审计记录

- **触发与前置条件**：任务启动或 turn 状态发生变化。
- **可观察行为**：Collab 在 `~/.local/chatgpt-pro-collab/` 下保留 task、turn 与返回文件元数据，并为每个 turn 保存 prompt 副本、原始附件路径清单、状态、完整 response 和 BEH-012 下载的文件。新 turn 不覆盖旧 turn；宿主之后改写原始 `promptPath` 不改变已保存副本。
- **验收条件**：任务关闭后仍能按 `taskId` 和 `turnId` 复原文字交互次序、返回文件顺序和本地路径；重复使用同一输入或返回文件名不会改变旧记录；发送附件正文不因审计目的被额外复制。
- **状态**：已确认。

### BEH-008 关闭本地任务

- **触发与前置条件**：宿主执行 `close(taskId)`。
- **可观察行为**：Collab 终止该任务的浏览器进程，同时保留 BEH-007 的 transcript 和 BEH-001 的共享认证源。`close` 不归档或删除 Web conversation，也不修改用户仓库。
- **验收条件**：浏览器进程不再存在；transcript 和共享认证源仍可读取；Web conversation 保持原状态；重复 `close` 不产生额外副作用。
- **状态**：已确认。

### BEH-009 显式归档 Web conversation

- **触发与前置条件**：宿主对活动任务执行 `archive(taskId)`。
- **可观察行为**：Collab 只在 ChatGPT Web 归档该任务绑定的 conversation；归档不隐式关闭本地任务，也不处理其他 conversation。
- **验收条件**：指定 conversation 进入 Web Archive；任务的本地进程和 transcript 不变；对已关闭任务调用时返回明确错误且不静默重启浏览器。
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

## 产品边界

- 宿主 Agent 对 prompt、附件与归档内容选择负责。宿主可以为 BEH-010 读取并打包明确选择的输入；Collab 输入选择层只解析和读取 BEH-003 明确传入的路径，不枚举或打开其他仓库输入。该边界不约束 Node.js、npm/npx、浏览器或操作系统读取其运行依赖、配置与缓存。Collab 运行时把附件视为不透明文件，不判断秘密、不检查 Git 状态，也不因 symlink、dirty worktree、分支或项目布局设置额外安全门。
- Collab 只操作由 BEH-001、BEH-002 和 BEH-009 指定的 ChatGPT Web 页面，不代替用户进行仓库修改、命令执行、patch 应用、提交、合并或发布。
- Pro 回复与返回文件都是原始协作输出。Pro 可以返回文字、git patch、`.tar.gz`、`.zip` 或其他产物；Collab 不要求固定回复格式，不识别或自动应用 diff、digest、receipt 或成功标记，不自动重发 prompt，也不根据回复内容阻塞后续宿主行为。宿主 Agent 负责验证、解压、执行、修改或应用这些输出。
- 认证源只保存在本机，不作为附件上传。各任务只读加载同一认证源，运行期间产生的 cookie 或 Web Storage 变化只保留在各自的内存 browser context；本版不新增 Unix 权限模式合同。
- 浏览器可见性、自动最小化、Dock 图标管理、返回产物自动集成和进程崩溃后的 conversation 恢复不在本版产品合同内。需要这些行为时必须新增或修订 `BEH-*`。

## 技术基线

以下 checkout 事实共同约束技术设计和验证方式：

- 当前 checkout 已有 `skills/chatgpt-pro-collab/` 实现、`tests/` 自动化测试以及可从任意宿主目录执行的绝对路径 CLI 入口。现有代码形成 BEH-001–BEH-003、BEH-005、BEH-006、BEH-008 和 BEH-009 的实现基线；只部分承载修订后的 BEH-004（有界页面检查与 Copy response）和 BEH-007（文字 transcript），尚未承载 `capturing`、artifact、BEH-010–BEH-012 或本规格的新 wait 参数。全部行为仍须按当前 VER 重新验证，不能把旧测试结果视为当前规格已通过。
- 运行约束为 Node.js `>=22.19.0`、ESM、TypeScript `^6.0.3` 和 Vitest `4.0.18`；格式化和 lint 分别使用 oxfmt 与 oxlint。当前 `tsconfig.json` 已采用 Node 原生 TypeScript type stripping 所需的 `erasableSyntaxOnly`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions` 与 `noEmit` 约束（REF-003）。
- 当前 manifest 没有浏览器自动化或数据库 npm dependency；`browser.ts` 固定调用 `@playwright/cli@0.1.17`，并已实现 named session、storage state 保存与加载、显式附件上传、有界页面检查、页面内文字捕获和归档后恢复绑定 conversation。固定 CLI 的命令能力由版本化官方资料承载（REF-001）。
- 当前 `state.ts` 使用 Node.js 标准库同步 `DatabaseSync` 保存 task/turn 状态和 browser-operation lease；schema 尚无 `capturing` 状态与 artifact 表（REF-002）。
- 当前 `send` 已能按顺序上传宿主明确指定的可读普通文件；当前 Skill 禁止打包，尚未实现 BEH-010 的宿主准备流程。当前 `wait` 在 CLI 进程内无限循环调用有界页面检查，完成后只返回 `responsePath`，尚未实现观察窗口、`pending` 终态、捕获时长或返回文件下载。

## 技术设计

### 实现机制与最小性

- **BEH-001–BEH-012 的 CLI 运行入口**：使用 Node.js 原生 type stripping 直接执行 ESM TypeScript，不生成运行产物，不引入 Jiti、tsx 或其他运行时转译器。运行代码只允许可擦除 TypeScript 语法，类型正确性由独立 `typecheck` 保证（REF-003）。
- **BEH-010 的输入归档**：由 Skill 指导宿主 Agent 使用当前执行环境已有的归档工具生成 `.tar.gz` 或 `.zip`，并在调用 `send` 前检查归档成员与所选输入一致。归档不得携带会在 Pro 沙盒中物化为额外文件的宿主扩展属性；macOS bsdtar 的目标命令使用 `COPYFILE_DISABLE=1` 和 `--no-xattrs`。Collab CLI 不增加 pack 命令，也不增加归档 dependency、manifest 或目录 schema。
- **BEH-001–BEH-006、BEH-008、BEH-009 与 BEH-012 的浏览器边界**：固定使用 `@playwright/cli@0.1.17`。`browser.ts` 通过参数数组调用 `npx -y @playwright/cli@0.1.17`，不经 shell 拼接，也不把 Playwright 写入项目 dependency。本版使用 setup 生成的 storage state 作为共享只读认证源；这里的只读表示 task 不回写 seed，不要求修改文件权限。每个 task 使用独立 named session 和独立内存 browser context（REF-001）。
- **BEH-011 的单次等待调用**：一次 `wait` 对应一个前台 CLI 进程。页面检查与等待全部在该进程内完成；CLI 在终态前不输出应用进度，结束时只返回一条终态 JSON。Skill 只发起这一次调用，不由 Agent 重复执行 `wait` 或另行检查浏览器来模拟订阅。
- **BEH-002–BEH-009、BEH-011 与 BEH-012 的跨命令协调状态**：继续使用 Node 标准库 `node:sqlite` 的同步 `DatabaseSync`。SQLite 保存 task、turn、返回文件和 browser-operation lease 的协调状态；逐 turn 文件保存可审计正文与返回产物（REF-002）。
- **BEH-001、BEH-003、BEH-004、BEH-007 与 BEH-012 的文件状态**：除 `state.sqlite` 外，文件系统保存认证数据、prompt、response、下载的返回文件和 Playwright 运行产物。SQLite 与 transcript 职责分开，不用 JSON 元数据文件复制数据库状态。

### 组件与职责

| 组件                      | 文件或边界                                     | 承载行为                                    | 职责                                                                               |
| ------------------------- | ---------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Skill entry               | `skills/chatgpt-pro-collab/SKILL.md`           | BEH-001–BEH-012                             | 触发边界、归档输入准备、宿主职责和 CLI 阶段路由；不复制页面或 SQL 实现             |
| CLI                       | `skills/chatgpt-pro-collab/scripts/collab.ts`  | BEH-001–BEH-009、BEH-011、BEH-012           | 参数解析、观察窗口、命令路由、单一终态结果与错误输出                               |
| Browser boundary          | `skills/chatgpt-pro-collab/scripts/browser.ts` | BEH-001–BEH-006、BEH-008、BEH-009、BEH-012  | Playwright CLI 进程调用、页面动作、目标 turn 完成检测、文字与文件捕获、归档        |
| State store               | `skills/chatgpt-pro-collab/scripts/state.ts`   | BEH-002–BEH-009、BEH-011、BEH-012           | `node:sqlite` schema、事务、task/turn/artifact 状态、operation lease 和并发写入    |
| Transcript/artifact store | `skills/chatgpt-pro-collab/scripts/session.ts` | BEH-001、BEH-003、BEH-004、BEH-007、BEH-012 | 数据目录、认证源、prompt/response 与返回文件的无覆盖发布、已有文件复用和一致性检查 |

不创建自定义常驻 task worker、全局 daemon 或新的 IPC 协议。Playwright CLI named session 保持每个 task 的浏览器实例；SQLite 保持跨命令状态。每次 Collab CLI 调用只打开所需数据库连接并调用目标 named session，因此两个 `wait` 进程可以并发操作不同 task，而同一 task 的状态门禁止第二个未完成 turn。

### 输入归档合同

- 宿主 Agent 先确定本轮输入集合，再决定直接附件或归档；不能为了方便打包而扩大已选择范围。代码任务需要批量传递时默认生成 `.tar.gz`，跨平台接收、任务明确要求或目标工具更适合 ZIP 时生成 `.zip`。
- 归档只包含所选 regular file 与承载其相对路径所需的目录项，不包含宿主扩展属性、resource fork、AppleDouble 或其他平台元数据。macOS bsdtar 生成 `.tar.gz` 时必须同时设置 `COPYFILE_DISABLE=1` 和 `--no-xattrs`；只设置 `COPYFILE_DISABLE=1` 不满足该合同。
- 归档成员路径、根目录、是否包含 git patch 或说明文件都由本轮协作需要决定。Skill 不规定 manifest、哈希、固定顶层目录或固定返回协议。
- 生成后必须在本地列出归档成员并与选择结果核对，再把该归档路径作为一个 `attachmentPath` 传给 `send`。归档临时文件是否保留由宿主决定；Collab 只记录其发送时绝对路径。
- Pro 在沙盒内自行解压并根据 prompt 工作；Collab 不发送额外解压控制消息，也不验证 Pro 的工作方法。

### Playwright CLI 合同

- `browser.ts` 使用固定命令前缀 `npx -y @playwright/cli@0.1.17 -s=<sessionName> --raw`；不同 task 不共享 session name、browser context 或输出目录，只共享只读认证源路径。
- `setup` 使用独立的非持久 setup session，通过 `open https://chatgpt.com/ --browser=chrome --headed` 完成人工登录。确认已登录后执行 `state-save <seedStatePath>`，成功保存 `auth/seed.json` 后关闭 setup session；不得保留完整 Chrome profile（REF-001）。
- `start` 以该 task 的 named session 执行 `open about:blank --browser=chrome --headed`、`state-load <seedStatePath>` 和 `goto https://chatgpt.com/`。只有观察到已登录页面后才返回 `taskId`；不同任务读取同一 seed 文件，之后产生的 cookie 或 Web Storage 变化只留在各自内存 browser context，不回写 seed。
- 启动、页面动作、上传、等待和关闭分别使用 `open`、`run-code --filename`、`upload`、`run-code --filename` 和 `close`。多个附件按 `attachmentPaths` 顺序逐个上传；BEH-010 生成的归档沿用同一单文件 upload，不增加特殊传输协议。
- Playwright 子进程设置 `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true`，允许访问宿主传入的任意绝对附件路径；这个能力只扩大 CLI 文件读取边界，不改变产品边界中由宿主负责选择文件的合同（REF-001）。
- ChatGPT 专属 selector、conversation identity、完成检测、回复 Copy、返回文件发现与下载和 Archive 全部封装在 `browser.ts`。当前实现以 composer `#prompt-textarea`、send `[data-testid="send-button"]`、turn `[data-testid^="conversation-turn-"][data-turn]`、Copy `[data-testid="copy-turn-action-button"]`、conversation options `[data-testid="conversation-options-button"]` 和 `/c/<conversationId>` canonical identity 为基线；selector 找不到或不唯一时返回页面合同漂移，不猜测相邻元素。易变页面合同只能由对应 live VER 证明，不能因当前代码存在而视为通过。
- `wait` 以最新 user turn 为锚点，只接受其后的 assistant turn；该 assistant 的 Copy 按钮可见且页面没有可见的 `Stop answering` 按钮时才判定完成。回复捕获在点击该 assistant 的 Copy 前临时拦截当前页面 `navigator.clipboard.write`/`writeText`，取得同一个 ClipboardItem 的 `text/plain` 和 `text/html` 后恢复原方法；`text/plain` 原样保存为 response，`text/html` 只用于当次文件发现。任一类型缺失时返回页面合同漂移，不读取或写入操作系统全局剪贴板。
- 同一个目标 assistant turn 同时作为返回文件发现边界。实现从 Copy response 的 `text/html` 按文档顺序提取 `sandbox:` anchor，按完整逻辑 URL 去重并保留首次出现位置；普通 `https:` 等链接不触发下载。去重前的 sandbox occurrence 与该 turn 中按文档顺序出现的 `button.behavior-btn` 按位置对应；数量不等时返回页面合同漂移。不得从其他 assistant turn、侧栏或页面其他区域发现文件（REF-004）。
- 目标 turn 的 artifact 行按首次出现顺序构成唯一 sandbox 目标的子序列。实现展开 artifact 列表，以逻辑目标 basename 和顺序把每行的 `Open file` 与同级 `Download file` 映射到对应目标；同名目标按顺序区分。映射到 artifact 行的目标通过行内 `Download file` 捕获 download event；未映射目标通过对应正文行为按钮捕获直接 download event。artifact 行无法形成无歧义子序列、事件没有发生或页面数量、顺序、控件关系发生变化时返回页面合同漂移，不猜测相邻控件（REF-004）。
- 每个唯一逻辑目标在页面动作前先建立 artifact 记录。`source_url` 保存完整 `sandbox:` 逻辑 URL；浏览器建议名称和带签名的实际下载 URL 只属于当次 download event，不作为目标身份。下载成功后使用建议名称作为原始名称，并保存到带 ordinal 的 turn 路径。
- 每次页面完成检查保持有界。服务层使用单调时钟分别控制 `observationWindowMs` 和 `captureTimeoutMs`；网页尚未报告完成且达到观察 deadline 时返回 `pending`。一旦观察到完成，观察 deadline 不再参与判断，服务在宿主侧 capture watchdog 内取得完整 Copy response 与有序 artifact 描述；此阶段达到捕获 deadline 时返回 `CAPTURE_TIMEOUT` 并保持 `pending`，后续 `wait` 重新观察并重取 Copy。取得完整描述后才以单个事务进入 `capturing`；捕获 deadline 继续覆盖本次调用的 response 发布与全部文件捕获，不按文件重新计时。turn 已经是 `capturing` 时从本次调用开始建立新的捕获 deadline；此后达到 deadline 时返回 `CAPTURE_TIMEOUT` 并保留 `capturing`。deadline 前发生的真实浏览器错误保留原错误码；watchdog 必须安全终止对应 command，不能遗留悬挂 command 或 operation lease。
- `archive` 只使用唯一的 `[data-testid="conversation-options-button"]` 和精确名称为 `Archive` 的 menuitem。脚本先观察 Archive menuitem，只有不可见时才打开菜单，避免把已打开菜单反向关闭；不得用模糊的 `Open conversation options` 匹配侧栏按钮。点击后等待离开目标 `/c/<conversationId>`，刷新侧栏并确认目标链接消失；随后重新导航到原 canonical URL，重新确认页面仍绑定原 `conversationId` 且目标 conversation turn 可定位，才返回成功。恢复后后续 `send` 与 `wait` 必须继续使用同一绑定。
- Playwright session 自身是浏览器生命周期权威；SQLite 只记录 session name 和已观察到的 conversation identity，不伪造浏览器仍存活。

### 命令与结果合同

| 命令      | 必要输入                                                                            | 成功结果                                                                                | 主要失败                                                                 |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `setup`   | 无                                                                                  | 认证源已建立，设置浏览器已关闭                                                          | 用户未完成登录；认证源无法生成                                           |
| `start`   | 无                                                                                  | `taskId`                                                                                | 未 setup；认证源读取或浏览器启动失败                                     |
| `send`    | `taskId`、`promptPath`、零或多个 `attachmentPath`                                   | 消息已提交并返回 `turnId`                                                               | task 非活动；本 task 已有未完成 turn；输入不可读；上传或提交失败         |
| `wait`    | `taskId`、`turnId`、有限正整数 `observationWindowMs`、有限正整数 `captureTimeoutMs` | `status: pending`；或 `status: completed`、`responsePath`、按顺序排列的 `artifactPaths` | 标识不存在；浏览器已退出；Web 状态无法判断；捕获超时；文字或文件捕获失败 |
| `close`   | `taskId`                                                                            | 本地任务已关闭                                                                          | 清理未完成时返回具体残留，不声称完整成功                                 |
| `archive` | 活动 `taskId`                                                                       | 指定 Web conversation 已归档，task 页面已恢复原绑定                                     | task 非活动；conversation 尚未建立；Web 操作失败                         |

`wait` 的命令形式为 `wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>`。`pending` 是本次有限观察正常到期的成功结果，不是 turn 失败；捕获超时使用错误码 `CAPTURE_TIMEOUT`。完成结果和 pending 结果都包含 `taskId` 与 `turnId`。CLI 在一次调用中不得输出进度 JSON，错误只通过现有非零退出码与单条错误 JSON 返回。

安装后的 Skill 以加载到的 `SKILL.md` 所在绝对目录定位 CLI，保持宿主项目为当前工作目录，并调用 `node "<skill-directory>/scripts/collab.ts" <command>`；不得要求宿主项目提供 `package.json` 或 `collab` package script。源码仓库保留 `"collab": "node skills/chatgpt-pro-collab/scripts/collab.ts"` 作为开发入口，调用形式为 `pnpm collab -- <command>`，并提供 `"test": "vitest --run"` 供 VER-010 使用。命令不得要求宿主提供 repository root、branch、snapshot、bundle 或授权 token。

### 最小状态与数据布局

每个 task 只定义 `active`、`closed`、`failed` 三种状态；每个 turn 定义 `sending`、`pending`、`capturing`、`completed`、`failed` 和 `unknown-submission`。`pending` 表示提交已成功，但尚未取得完整 Copy response 与有序 artifact 描述并原子建立 `capturing` 边界；它是本地持久化阶段，不等同于 Pro 必然仍在生成。`capturing` 表示原始 response 路径与完整 artifact 集已经冻结，后续只允许发布或核对原始文字并下载返回文件，不能再返回成功的 `pending` 结果。`unknown-submission` 只用于浏览器在提交边界失败、实现无法证明消息是否已经发送的真实歧义，不能被自动重试掩盖。

```text
~/.local/chatgpt-pro-collab/
├── state.sqlite                     # task/turn 控制状态
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

SQLite 只保存协调状态和文件索引，不保存 prompt、response 或返回文件正文。目标 schema 包含三张表：

| 表         | 主键                        | 必要字段                                                                                                                                     |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`     | `id`                        | `playwright_session`、`conversation_id`、`conversation_url`、`status`、browser-operation lease 字段、`created_at`、`updated_at`、`closed_at` |
| `turn`     | `task_id, id`               | `status`、`prompt_path`、`attachments_json`、`response_path`、`error`、`created_at`、`updated_at`                                            |
| `artifact` | `task_id, turn_id, ordinal` | `source_url`、`label`、`filename`、`local_path`、`status`、`error`、`created_at`、`updated_at`                                               |

`task.status` 只允许 `active | closed | failed`；`turn.status` 只允许 `sending | pending | capturing | completed | failed | unknown-submission`；`artifact.status` 只允许 `pending | completed`。`turn.task_id` 与 artifact 的 task/turn 组合使用外键关联，session name 唯一，单个 turn 的 `source_url` 唯一。所有时间使用 ISO 8601 UTC 字符串；附件数组按上传顺序编码为 JSON 字符串。

每个 CLI 进程使用自己的 `DatabaseSync` 连接，并设置 `foreign_keys=ON`、WAL journal 和有限 busy timeout。会影响状态门或外部副作用归属的变更在 `BEGIN IMMEDIATE` 事务中完成；业务代码不得依赖进程内全局状态代替数据库约束。

prompt 文件成功落盘后，turn 才能从 `sending` 进入 `pending`。观察到网页完成后，turn 在取得 Copy response 与完整有序 artifact 描述期间仍保持 `pending`；超时、中断或浏览器错误不得留下 response 路径或部分 artifact 行。取得全部数据后，单个 `BEGIN IMMEDIATE` 事务必须同时把 turn 从 `pending` 置为 `capturing`、记录确定的 `response_path`，并按页面顺序建立全部 artifact 行；事务只能全部提交或全部回滚，不得把 `beginCapture` 与 artifact 建行拆成两个事务。事务提交后才发布 `response.md` 和返回文件。每个文件先写同目录临时文件，再无覆盖地发布到最终路径并标为 completed。只有 response 和全部 artifact 文件均可读时，turn 才能进入 `completed`。

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
- `send` 先写入 turn 标识和 prompt 副本，再进行浏览器副作用；只有确认消息已提交后才返回成功。提交结果不明确时记录 `unknown-submission`，不自动重发。
- `wait` 的内部页面检查、operation lease 释放和再次检查都不写宿主可见进度；网页未报告完成且达到观察 deadline 后才返回一次 pending。网页已报告完成但捕获在原子边界前失败时返回真实错误并保持持久状态 `pending`；后续重试仍重新观察目标 turn 并重取 Copy。turn 进入 `capturing` 后，重试跳过生成等待，先执行捕获恢复核对，再复用已完成 artifact 并只下载未完成项。
- completed turn 的 `wait` 是幂等读取；`close` 是幂等清理。`archive` 依赖 Web 端实际状态，只有观察到指定 conversation 已归档且 task 页面恢复原绑定才返回成功。
- 观察窗口不会关闭 task 或取消远端生成。调用环境中断时，Playwright session 和未完成 turn 继续存在，后续可再次 `wait`。
- 回复捕获不得依赖未经隔离验证的全局剪贴板。若驱动必须使用 Copy 控件，VER-004 和 VER-006 必须证明并发任务不会读到彼此内容。

### 失败与运行边界

- 输入路径、归档生成、浏览器动作、返回文件下载或本地写入失败时返回具体操作和原因；不得把失败记为 completed，也不得因为失败扫描更多本地文件。
- 不进行自动 prompt 重发、Playwright session 自动重启或 conversation 自动迁移。浏览器进程崩溃时保留 SQLite 状态与已有 transcript，并报告任务不可用；崩溃恢复属于后续规格。
- BEH-008 的进程终止出现部分失败时，保留可定位的进程或 session 信息并返回失败；不删除 transcript 来伪造清理完成。
- task 和 turn 标识必须不可碰撞；prompt、response 和返回文件写入先落到同目录临时文件，再无覆盖地发布各自目标文件。已经发布的文件不再覆盖；相同 `sandbox:` 目标只关联一个本地文件。
- Pro 与本地 Agent 是受信任的协作方。Collab 对返回文件只承担保存职责，不自动解压、预览、执行、应用 patch 或修改权限；这些动作由宿主在 `wait` 返回后按任务需要决定。
- `browser.ts` 是 ChatGPT Web 易变接口的唯一承载层。selector、完成检测、Copy response、`sandbox:` 文件发现与下载和 Archive 必须在固定 Playwright CLI 版本与 live 环境中验证后才能视为已实现。

## 验收与验证

### VER-001 共享认证源

- **覆盖对象**：BEH-001。
- **前置条件**：可交互登录的 Pro 账号与干净认证目录。
- **执行或检查**：使用固定 Playwright CLI 登录并 `state-save`；关闭 setup session，从同一 seed state 同时执行两次 `start`。
- **通过证据**：setup session 已关闭；两个非持久 task session 均已登录且未再次请求登录；seed 文件未被 task 改写。
- **证明边界**：不证明认证长期不过期。
- **必需性**：必需。

### VER-002 独立任务启动

- **覆盖对象**：BEH-002。
- **前置条件**：VER-001 通过。
- **执行或检查**：同时启动两个任务，检查 Playwright session、浏览器进程、browser context 和 session 目录，并分别完成首次发送。
- **通过证据**：两个任务具有不同 named session、浏览器 PID、内存 browser context、taskId、session 路径和 conversation。
- **证明边界**：不证明消息并发或回复隔离。
- **必需性**：必需。

### VER-003 显式输入边界

- **覆盖对象**：BEH-003 与产品边界。
- **前置条件**：活动任务；当前目录含 dirty Git 状态、未指定文件和 symlink；输入选择层使用可观察或可注入的文件访问边界。
- **执行或检查**：从工作区内外各选择明确的普通附件执行 `send`，记录输入选择层的路径解析、文件访问和读取调用；另以 live Web 检查实际上传项，不传入其他文件。
- **通过证据**：输入选择层只解析和访问指定 prompt 与附件；显式外部路径可上传；Web 输入与指定内容一致且没有未指定上传项或归档；返回 turnId。
- **证明边界**：不约束 Node.js、npm/npx、浏览器或操作系统读取其运行依赖、配置与缓存；不证明归档输入或 Pro 回复正确。
- **必需性**：必需。

### VER-004 原始文字捕获

- **覆盖对象**：BEH-004。
- **前置条件**：已发送包含长文本与代码块、可产生无文件回复的 turn。
- **执行或检查**：使用足够的观察窗口与捕获超时执行 `wait`；检查目标 assistant、`Stop answering` 与 Copy 状态，将页面内 Copy response 和 `response.md` 逐字节比较，再重复 wait。
- **通过证据**：返回 completed；内容一致；没有读取系统剪贴板；artifactPaths 为空；重复调用返回同一路径且旧 response 未覆盖。
- **证明边界**：不覆盖返回文件下载或单次等待行为。
- **必需性**：必需。

### VER-005 同一任务多轮

- **覆盖对象**：BEH-005。
- **前置条件**：同一 task 的首个 turn 已完成。
- **执行或检查**：发送引用上文的第二个 prompt 并等待。
- **通过证据**：conversation 标识不变；第二次回复使用上文；两个 turn 文件独立。
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

- **覆盖对象**：BEH-007、BEH-012。
- **前置条件**：至少两个 completed turn 使用过同名 prompt 和返回文件名。
- **执行或检查**：修改原 prompt 文件；检查 SQLite 与 turn 目录；关闭任务后用新的 CLI 进程复读。
- **通过证据**：task、turn、artifact 顺序和路径可查询；prompt、response、返回文件保持原内容；发送附件正文没有副本。
- **证明边界**：不保证已修改发送附件的字节级复原。
- **必需性**：必需。

### VER-008 本地任务关闭

- **覆盖对象**：BEH-008。
- **前置条件**：活动任务且 Web conversation 已建立。
- **执行或检查**：执行 `close` 两次并检查 Playwright session、本地目录与 Web。
- **通过证据**：named session 和浏览器进程消失；SQLite、transcript、返回文件与共享 seed 保留；Web 未归档；第二次调用无额外副作用。
- **证明边界**：不证明操作系统能清理被外部程序锁定的文件。
- **必需性**：必需。

### VER-009 Web conversation 归档与恢复

- **覆盖对象**：BEH-005、BEH-009。
- **前置条件**：活动任务且 Web conversation 已建立。
- **执行或检查**：执行 `archive`，等待离开目标 canonical URL，刷新侧栏并确认归档；随后检查恢复后的页面绑定，再在同一 task 执行一次 send/wait。
- **通过证据**：刷新后目标 conversation 不在侧栏；页面恢复到原 `/c/<conversationId>` 且原 turn 可定位；后续 send/wait 仍使用相同 conversation 标识；进程和 transcript 保持；其他 conversation 不变。
- **证明边界**：只覆盖当次 ChatGPT Web Archive 与 canonical URL 恢复界面。
- **必需性**：必需。

### VER-010 确定性实现检查

- **覆盖对象**：BEH-001–BEH-012 的确定性实现。
- **前置条件**：依赖已安装，目标代码和测试存在。
- **执行或检查**：在最后一次相关修改后运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm collab -- help`；从无 `package.json` 的临时宿主目录用绝对路径执行 Skill CLI `help`。
- **通过证据**：每条命令退出码为 0；入口不依赖宿主 package manifest；help 含两个 wait 时长参数；测试输出可追溯对应 `BEH-*`。
- **证明边界**：不证明真实 ChatGPT Web 或用户主动中断行为。
- **必需性**：必需。

### VER-011 中断恢复与并发状态

- **覆盖对象**：BEH-002、BEH-004、BEH-006、BEH-007、BEH-012。
- **前置条件**：state 与文件存储实现及测试存在。
- **执行或检查**：以多进程覆盖不同 task，并分别在原子 capturing 事务提交前、事务提交后、response 发布后、artifact 发布但状态更新前、部分 artifact 完成后终止进程；重开数据库并执行恢复矩阵，最后并发 close。
- **通过证据**：事务提交前的中断只保留完整 `pending`，提交后一次可见 `capturing`、response_path 与全部 artifact 行；无丢失更新、半冻结状态或跨 task 污染；各后续中断点都能复用或补齐一致内容；不一致使用规定错误码；文件无覆盖；completed 不变量保持；重启后可继续。
- **证明边界**：不证明浏览器、下载或 ChatGPT Web 行为。
- **必需性**：必需。

### VER-012 运行前提

- **覆盖对象**：BEH-001–BEH-012 的运行前提。
- **前置条件**：Node.js v22.19.0、当前受支持 Node、npm/npx 和网络可用。
- **执行或检查**：分别在最低与当前 Node 执行版本检查、`node:sqlite` DatabaseSync 内存库 smoke test 和最小 `.ts` 入口 smoke test；执行固定 Playwright CLI help。
- **通过证据**：两个 Node 版本的 smoke test 与 `npx -y @playwright/cli@0.1.17 --help` 退出码均为 0。
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
- **执行或检查**：让目标 turn 返回 HTML、ZIP、图片、源码、两个同名文件、重复 sandbox 目标和普通 HTTPS 链接；执行带两个时长的 wait，核对 Copy response 的两种 ClipboardItem 类型、sandbox occurrence 与正文按钮的顺序、artifact 子序列、直接与 artifact download event 以及落盘文件；另用确定性故障注入覆盖页面数量或顺序漂移、部分下载失败、原子边界前后捕获超时、重试及下载跨过观察 deadline。
- **通过证据**：Copy response 原样保存；唯一 sandbox 文件按顺序落盘；重复项只下载一次；同名目标以逻辑 URL 区分且本地文件不覆盖；HTTPS 未下载；直接与 artifact 页面路径均成功产生对应 download event；页面映射不一致时返回页面合同漂移；原子边界前捕获超时返回 `CAPTURE_TIMEOUT` 且保持完整 `pending`，边界后捕获超时返回同一码并保持 `capturing`；deadline 前的真实浏览器错误保留原码；重试分别重取 Copy 或复用已冻结内容并完成；不因观察 deadline 返回成功的 pending。
- **证明边界**：只覆盖当次 ChatGPT Web 文件 UI 与注入的下载失败路径。
- **必需性**：必需。

VER-001–VER-015 均为完成本规格的必需验证。涉及真实 ChatGPT Web 的 VER-001–VER-009、VER-013 和 VER-015 未经 live 执行，不得以 mock、单元测试或代码审查声称通过；VER-014 必须实际运行 Skill 与 CLI，并取得调用次数、页面检查和进程输出证据，不能只检查 Skill 文案或页面循环的单元测试。

**相关修改**是指改变任一 `VER-*` 的覆盖行为、组件映射、状态、接口、前置条件、执行步骤或证据判据的变更。全部必需 `VER-*` 必须在最后一次相关修改后重新通过；局部修复至少重跑失败的 `VER-*`、所有受影响的 `VER-*`、VER-010 和 VER-012；涉及 SQLite 状态时还必须重跑 VER-011。

执行前必须重新核对：采用的仍是本文件及其当前版本；阻塞未决事项已经解除；目标仓库中的运行版本、browser dependency、命令入口和测试入口与技术设计一致；工作区已有改动已识别且不会被覆盖或归入本次实现。

失败后按证据分流：实现偏离 `BEH-*` 时修复最小实现根因；测试与 `BEH-*` 冲突时只在直接证据支持下修订测试；ChatGPT Web、权限或环境不可用时记录失败动作和缺失前置，不修改产品代码伪造通过；外部接口或 checkout 漂移时重新取证，若漂移会改变产品行为则暂停并请求用户裁决。

没有新证据，且下一步不会引入新的可验证假设、证据来源或不同修复动作时，停止重复尝试。报告已尝试动作、现有证据、阻塞原因和解除条件；固定重试次数不能替代该判断。

完成条件是：所有 `BEH-*`、产品边界和不可接受结果均有验证覆盖；VER-001–VER-015 在最后一次相关修改后通过；本规格标记为需要直接检查的 SQLite、session 文件、浏览器进程、Playwright session、Web conversation、transcript、返回文件和 CLI 终态结果已实际检查；不存在阻塞未决事项；最终变更未加入仓库理解、返回产物自动集成或其他规格外能力。

## 决策记录

| 选择                                | 状态   | 理由                                                                                                  | 影响                                                                  |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 轻量浏览器协作通道                  | 已确认 | 仓库理解、安全判断和代码集成不属于浏览器传输职责；核心只保留协作输入、浏览器操作和原始输出            | BEH-001–BEH-012、产品边界、技术设计                                   |
| 每 task 独立浏览器进程              | 已确认 | 多任务必须能够同时等待和操作，不能由共享浏览器或串行控制互相影响                                      | BEH-002、BEH-006、VER-002、VER-006                                    |
| 宿主显式提供输入                    | 已确认 | Collab 不可能可靠理解所有用户项目；文件与归档内容应由掌握任务上下文的宿主负责                         | BEH-003、BEH-010、产品边界、VER-003、VER-013                          |
| send 与 wait 分离                   | 已确认 | Pro 可能长时间生成；提交不应占住宿主模型或阻止其他任务继续工作                                        | BEH-003、BEH-004、BEH-006、BEH-011                                    |
| 一次 wait 只产生一个终态结果        | 已确认 | 让 Agent 反复检查会浪费 token；页面检查应由浏览器层承担，宿主只在完成、到期或真实错误时取得结果       | BEH-004、BEH-011、CLI、VER-014                                        |
| 生成观察与结果捕获使用独立时长      | 已确认 | 观察窗口只决定何时返回 pending；回复完成后仍需给整轮文件捕获一个独立、有限且可重试的执行窗口          | BEH-004、BEH-012、命令合同、VER-014、VER-015                          |
| capturing 以完整描述原子冻结为边界  | 已确认 | 网页完成观察不是可恢复的数据边界；response 路径与完整 artifact 集必须同时可见，边界前错误保持 pending | BEH-004、BEH-012、SQLite 合同、VER-011、VER-015                       |
| `.tar.gz` 默认、`.zip` 可选         | 已确认 | 归档用于避免上传大量分散文件；代码任务偏向 tar，跨平台或任务约定需要 zip，同时不固定协作协议          | BEH-010、输入归档合同、VER-013                                        |
| 原始回复与产物交给宿主解释          | 已确认 | 固定 response schema、diff 或 receipt 解析会写死协作方式；Pro 和宿主应按任务选择 patch、归档或文字    | BEH-004、BEH-012、产品边界、VER-004、VER-015                          |
| 全部 sandbox 文件落盘后才 completed | 已确认 | 宿主被唤醒时应拿到可操作的完整结果；生成观察窗口不应截断已开始的文件捕获                              | BEH-004、BEH-012、capturing 状态、VER-011、VER-015                    |
| close 与 Web archive 分离           | 已确认 | 本地进程生命周期与 Web conversation 生命周期是两种独立副作用，必须由不同显式命令触发                  | BEH-008、BEH-009、VER-008、VER-009                                    |
| Playwright CLI 浏览器边界           | 已确认 | 固定版本外部 CLI 提供 session、storage state 和页面命令；浏览器易变细节集中在单一边界（REF-001）      | Browser boundary、VER-001–VER-006、VER-008、VER-009、VER-012、VER-015 |
| 共享只读 storage state              | 已确认 | 共享 seed 只提供启动认证数据；每 task 独立 browser context 承担运行时状态隔离，复制 seed 不增加隔离   | BEH-001、BEH-002、BEH-006、VER-001、VER-002、VER-006                  |
| SQLite 与正文/文件分离              | 已确认 | 结构化状态需要事务和跨进程恢复；文字与返回文件仍应直接可读、逐 turn 无覆盖                            | State store、Transcript/artifact store、VER-007、VER-011、VER-012     |

## 参考资料

| ID      | 名称                              | 位置                                                                  | 版本或日期         |
| ------- | --------------------------------- | --------------------------------------------------------------------- | ------------------ |
| REF-001 | Playwright CLI README             | https://github.com/microsoft/playwright-cli/blob/v0.1.17/README.md    | v0.1.17            |
| REF-002 | Node.js SQLite API                | https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html     | Node.js v22.19.0   |
| REF-003 | Node.js TypeScript type stripping | https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html | Node.js v22.19.0   |
| REF-004 | ChatGPT Web 返回文件页面 Spike    | `docs/evidence/2026-08-05-chatgpt-web-return-files.md`                | 2026-08-05 live UI |
