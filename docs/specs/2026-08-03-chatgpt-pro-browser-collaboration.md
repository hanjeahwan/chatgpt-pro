# ChatGPT Pro 浏览器协作

- status: approved
- version: 0.1

## 背景与目标

本产品是宿主 Agent 与 ChatGPT Pro Web 之间的轻量协作通道。宿主 Agent 决定任务内容和本地文件范围；Collab 只负责维护浏览器会话、发送明确输入、等待回复并保存可审计记录。

目标是让一个宿主同时维护多个互不影响的 Pro 任务，并在每个任务中持续多轮对话。成功时，宿主可以在任务 A 等待长时间回复期间继续操作任务 B；每项任务都有独立浏览器进程、独立 Web conversation 和独立 transcript。

本版不承担仓库理解或代码集成。Git 工作区、worktree、快照、bundle、manifest、patch 应用、合并和冲突处理都由宿主 Agent 或用户决定，不进入 Collab 协议。

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
- **可观察行为**：Collab 读取 `promptPath`，只上传 `attachmentPaths` 中列出的文件，向该任务的 conversation 提交一次消息，随后立即返回唯一 `turnId`，不等待 Pro 完成回复。
- **验收条件**：Web 端收到的 prompt 与指定文件一致；未列出的仓库文件不会被读取、打包或上传；调用方在消息提交完成后取得 `turnId`。
- **状态**：已确认。

### BEH-004 等待并捕获原始回复

- **触发与前置条件**：宿主执行 `wait(taskId, turnId)`，且该 turn 已提交。
- **可观察行为**：Collab 等待该 turn 的 Pro 回复完成，捕获 Web 端完整 Copy response，将内容写入该 turn 专属且不覆盖其他 turn 的 `response.md`，并返回 `responsePath`。Collab 不解析、总结、验证或执行回复内容。
- **验收条件**：返回文件与该 turn 在 Web 端的完整 Copy response 一致；同一 completed turn 再次 `wait` 返回同一路径；调用方中断或等待环境超时不会停止远端生成、关闭任务或把 turn 伪装成失败。
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
- **可观察行为**：Collab 在 `~/.local/chatgpt-pro-collab/` 下保留 task/turn 元数据，并为每个 turn 保存 prompt 副本、原始附件路径清单、状态和完整 response。新 turn 不覆盖旧 turn；宿主之后改写原始 `promptPath` 不改变已保存副本。
- **验收条件**：任务关闭后仍能按 `taskId` 和 `turnId` 复原文字交互次序；重复使用同一输入文件名不会改变旧记录；附件正文不因审计目的被额外复制。
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

## 产品边界

- 宿主 Agent 对 prompt 和附件选择负责。Collab 把附件视为不透明文件，不扫描仓库、不判断秘密、不检查 Git 状态，也不因 symlink、dirty worktree、旧任务、分支或项目布局设置额外安全门。
- Collab 只操作由 BEH-001、BEH-002 和 BEH-009 指定的 ChatGPT Web 页面，不代替用户进行仓库修改、命令执行、patch 应用、提交、合并或发布。
- Pro 回复是原始协作输出。Collab 不要求固定回复格式，不识别 diff、digest、receipt 或成功标记，不自动重发 prompt，也不根据回复内容阻塞后续宿主行为。
- 认证源只保存在本机，不作为附件上传。各任务只读加载同一认证源，运行期间产生的 cookie 或 Web Storage 变化只保留在各自的内存 browser context；本版不新增 Unix 权限模式合同。
- 本版不兼容、不迁移，也不以旧 `chatgpt-pro-collab` 实现的 task、bundle、SQLite 或浏览器状态作为运行输入。开发与验收产生的临时数据由执行环境在运行前备份或重建；实现不得为这些临时数据增加运行时来源标记、版本识别、拒绝或 migration gate。旧项目只作为被替代背景，不是新实现的运行依赖。
- 浏览器可见性、自动最小化、Dock 图标管理和进程崩溃后的 conversation 恢复不在本版产品合同内。需要这些行为时必须新增或修订 `BEH-*`。

## 技术基线

以下 checkout 事实与已完成的 live spike 共同约束技术设计和验证方式：

- 目标仓库位于 `/Users/codeartz/workspaces/chatgpt-pro`。实现只以该仓库当前检出的代码与本规格为基线，不读取旧项目的运行状态。
- 仓库目前只有工具链和文档骨架，没有 `skills/**/*.ts`、`tests/**/*.ts` 或 `evals/**/*.ts` 实现。`package.json` 当前只提供格式、lint 和类型检查脚本；VER-010 所需的测试与 CLI 入口尚不存在。
- 运行约束为 Node.js `>=22.19.0`、ESM、TypeScript `^6.0.3` 和 Vitest `4.0.18`；格式化和 lint 分别使用 oxfmt 与 oxlint。当前 `tsconfig.json` 已采用 Node 原生 TypeScript type stripping 所需的 `erasableSyntaxOnly`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions` 与 `noEmit` 约束（REF-003）。
- 当前 manifest 没有浏览器自动化或数据库 npm dependency。2026-08-03 执行 `npm view @playwright/cli version` 得到 latest `0.1.17`；该固定版本提供 named session、persistent/profile、upload、run-code 和 close（REF-001）。其 npm package 固定依赖 Playwright `1.62.0-alpha-1783623505000`。
- 2026-08-03 使用 `@playwright/cli@0.1.17` 完成认证方案对比 spike。完整 Chrome profile 与 storage state 都能让两个 named session 同时进入 ChatGPT Pro；两个 session 可从同一 storage state 文件启动，其 `userDataDir` 为 `null`、`persistent` 为 `false`，后续分别写入 `A`、`B` 时保持隔离。实测完整 profile 为 78,460 KiB，storage state 为 184 KiB。CLI 当前未保存 IndexedDB，但 live 结果证明当前 ChatGPT 登录不依赖该部分状态（REF-004）。
- 同日 live spike 验证了两个独立 headed session、两个 conversation、明确附件上传、重叠生成、页面内 Copy response 隔离和 Archive。两个并发回复各捕获 3,852 字符，只含各自 marker；归档后刷新页面，目标 conversation 从侧栏消失，另一 session 不受影响。
- 当前本机 Node.js v25.9.0 已实际加载 `node:sqlite.DatabaseSync` 并成功打开、关闭内存数据库。项目最低版本 Node.js v22.19.0 的官方 API 也提供同步 `DatabaseSync` 且无需实验 flag，但该版本仍把 SQLite 标记为 Active development；实现只使用本规格列出的基础 API，并在最低版本复验（REF-002）。

## 技术设计

### 实现机制与最小性

- **BEH-001–BEH-009 的 CLI 运行入口**：使用 Node.js 原生 type stripping 直接执行 ESM TypeScript，不生成运行产物，不引入 Jiti、tsx 或其他运行时转译器。运行代码只允许可擦除 TypeScript 语法，类型正确性由独立 `typecheck` 保证（REF-003）。
- **BEH-001–BEH-006、BEH-008 与 BEH-009 的浏览器边界**：固定使用 `@playwright/cli@0.1.17`。`browser.ts` 通过参数数组调用 `npx -y @playwright/cli@0.1.17`，不经 shell 拼接，也不把 Playwright 写入项目 dependency。V1 使用 setup 生成的 storage state 作为共享只读认证源；这里的只读表示 task 不回写 seed，不要求修改文件权限。每个 task 使用独立 named session 和独立内存 browser context，不创建持久 task profile 或 task 认证状态副本（REF-001、REF-004）。
- **BEH-002–BEH-009 的跨命令协调状态**：使用 Node 标准库 `node:sqlite` 的同步 `DatabaseSync`，不引入第三方 ORM 或数据库 package。SQLite 保存 task/turn 的协调状态，逐 turn 文件保存 BEH-007 要求的可审计正文（REF-002）。
- **BEH-001、BEH-003、BEH-004 与 BEH-007 的文件状态**：除 `state.sqlite` 外，文件系统只保存认证数据、prompt、response 和 Playwright 运行产物。SQLite 与 transcript 职责分开，不用 JSON 元数据文件复制数据库状态。

### 组件与职责

| 组件             | 文件                                           | 承载行为                           | 职责                                                                     |
| ---------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Skill entry      | `skills/chatgpt-pro-collab/SKILL.md`           | BEH-001–BEH-009                    | 触发边界、宿主输入职责和 CLI 阶段路由；不复制页面或 SQL 实现             |
| CLI              | `skills/chatgpt-pro-collab/scripts/collab.ts`  | BEH-001–BEH-009                    | 参数解析、命令路由、稳定结果与错误输出；不实现页面或 SQL 细节            |
| Browser boundary | `skills/chatgpt-pro-collab/scripts/browser.ts` | BEH-001–BEH-006、BEH-008–BEH-009   | Playwright CLI 进程调用、session/storage state、页面动作、回复捕获与归档 |
| State store      | `skills/chatgpt-pro-collab/scripts/state.ts`   | BEH-002–BEH-009                    | `node:sqlite` schema、事务、task/turn 状态和并发写入                     |
| Artifact store   | `skills/chatgpt-pro-collab/scripts/session.ts` | BEH-001、BEH-003、BEH-004、BEH-007 | 数据目录、认证源、prompt/response 原子写入                               |

不创建自定义常驻 task worker、全局 daemon 或 IPC 协议。Playwright CLI named session 保持每个 task 的浏览器实例；SQLite 保持跨命令状态。每次 Collab CLI 调用只打开所需数据库连接并调用目标 named session，因此两个 `wait` 进程可以并发操作不同 task，而同一 task 的状态门禁止第二个未完成 turn。

### Playwright CLI 合同

- `browser.ts` 使用固定命令前缀 `npx -y @playwright/cli@0.1.17 -s=<sessionName> --raw`；不同 task 不共享 session name、browser context 或输出目录，只共享只读认证源路径。
- `setup` 使用独立的非持久 setup session，通过 `open https://chatgpt.com/ --browser=chrome --headed` 完成人工登录。确认已登录后执行 `state-save <seedStatePath>`，成功保存 `auth/seed.json` 后关闭 setup session；不得保留完整 Chrome profile（REF-001、REF-004）。
- `start` 以该 task 的 named session 执行 `open about:blank --browser=chrome --headed`、`state-load <seedStatePath>` 和 `goto https://chatgpt.com/`。只有观察到已登录页面后才返回 `taskId`；不同任务读取同一 seed 文件，之后产生的 cookie 或 Web Storage 变化只留在各自内存 browser context，不回写 seed。
- 启动、页面动作、上传、等待和关闭分别使用 `open`、`run-code --filename`、`upload`、`run-code --filename` 和 `close`。多个附件按 `attachmentPaths` 顺序逐个上传，不依赖单次多文件参数解析。
- Playwright 子进程设置 `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true`，允许访问宿主传入的任意绝对附件路径；这个能力只扩大 CLI 文件读取边界，不改变产品边界中由宿主负责选择文件的合同（REF-001）。
- ChatGPT 专属 selector、conversation identity、完成检测、回复 Copy 和 Archive 全部封装在 `browser.ts` 的 `run-code` 脚本中。V1 优先使用已验证的稳定属性：composer `#prompt-textarea`、send `[data-testid="send-button"]`、turn `[data-testid^="conversation-turn-"][data-turn]`、Copy `[data-testid="copy-turn-action-button"]`、conversation options `[data-testid="conversation-options-button"]`；canonical conversation identity 来自 `/c/<conversationId>`。selector 找不到或不唯一时返回页面合同漂移，不猜测相邻元素。
- `wait` 以最新 user turn 为锚点，只接受其后的 assistant turn；该 assistant 的 Copy 按钮可见且页面没有可见的 `Stop answering` 按钮时才判定完成。回复捕获在点击该 assistant 的 Copy 前临时拦截当前页面 `navigator.clipboard.write`/`writeText`，读取 `text/plain` 后恢复原方法；不得读取或写入操作系统全局剪贴板。
- `archive` 只使用唯一的 `[data-testid="conversation-options-button"]` 和精确名称为 `Archive` 的 menuitem。脚本先观察 Archive menuitem，只有不可见时才打开菜单，避免把已打开菜单反向关闭；不得用模糊的 `Open conversation options` 匹配侧栏按钮。点击后等待离开目标 `/c/<conversationId>`，刷新侧栏并确认目标链接消失，才返回成功。
- Playwright session 自身是浏览器生命周期权威；SQLite 只记录 session name 和已观察到的 conversation identity，不伪造浏览器仍存活。

### 命令与结果合同

| 命令      | 必要输入                                          | 成功结果                       | 主要失败                                                         |
| --------- | ------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `setup`   | 无                                                | 认证源已建立，设置浏览器已关闭 | 用户未完成登录；认证源无法生成                                   |
| `start`   | 无                                                | `taskId`                       | 未 setup；认证源读取或浏览器启动失败                             |
| `send`    | `taskId`、`promptPath`、零或多个 `attachmentPath` | 消息已提交并返回 `turnId`      | task 非活动；本 task 已有未完成 turn；输入不可读；上传或提交失败 |
| `wait`    | `taskId`、`turnId`                                | `responsePath`                 | 标识不存在；浏览器已退出；Web 状态无法判断或回复捕获失败         |
| `close`   | `taskId`                                          | 本地任务已关闭                 | 清理未完成时返回具体残留，不声称完整成功                         |
| `archive` | 活动 `taskId`                                     | 指定 Web conversation 已归档   | task 非活动；conversation 尚未建立；Web 操作失败                 |

命令入口固定为 package script `"collab": "node skills/chatgpt-pro-collab/scripts/collab.ts"`，调用形式为 `pnpm collab -- <command>`。实现同时提供 `"test": "vitest --run"` 供 VER-010 使用。命令不得要求宿主提供 repository root、branch、snapshot、bundle 或授权 token。

### 最小状态与数据布局

每个 task 只定义 `active`、`closed`、`failed` 三种状态；每个 turn 只定义 `sending`、`pending`、`completed`、`failed` 和 `unknown-submission`。`unknown-submission` 只用于浏览器在提交边界失败、实现无法证明消息是否已经发送的真实歧义，不能被自动重试掩盖。

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
                └── response.md       # completed 后存在，后续不覆盖
```

附件只从宿主提供的原路径上传，并在 SQLite turn 记录中保存有序绝对路径，不复制到 session 目录。这个 transcript 能审计文字交互和当时选择的路径，但不承诺在原附件被修改或删除后复原附件字节。

### SQLite 合同

SQLite 只保存协调状态，不保存 prompt 或 response 正文。初始 schema 只包含两张表：

| 表     | 主键          | 必要字段                                                                                                       |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `task` | `id`          | `playwright_session`、`conversation_id`、`conversation_url`、`status`、`created_at`、`updated_at`、`closed_at` |
| `turn` | `task_id, id` | `status`、`prompt_path`、`attachments_json`、`response_path`、`error`、`created_at`、`updated_at`              |

`task.status` 只允许 `active | closed | failed`；`turn.status` 只允许 `sending | pending | completed | failed | unknown-submission`。`turn.task_id` 使用外键关联 task，session name 唯一。所有时间使用 ISO 8601 UTC 字符串；附件数组按上传顺序编码为 JSON 字符串。

每个 CLI 进程使用自己的 `DatabaseSync` 连接，并设置 `foreign_keys=ON`、WAL journal 和有限 busy timeout。会影响状态门或外部副作用归属的变更在 `BEGIN IMMEDIATE` 事务中完成；业务代码不得依赖进程内全局状态代替数据库约束。

prompt 文件成功落盘后，turn 才能从 `sending` 进入 `pending`。回复先写入同目录临时文件并原子替换 `response.md`，然后在事务中进入 `completed`；数据库显示 completed 时，对应 response 文件必须已经存在。数据库损坏或文件与状态不一致时返回真实错误，不自动删除 transcript 或重建成功状态。

### 顺序、并发与幂等

- 同一 task 的 CLI 调用通过 SQLite 状态门和同一个 Playwright named session 排序；不同 task 使用不同 named session、浏览器进程、browser context 和 turn 目录。
- `send` 先写入 turn 标识和 prompt 副本，再进行浏览器副作用；只有确认消息已提交后才返回成功。提交结果不明确时记录 `unknown-submission`，不自动重发。
- completed turn 的 `wait` 是幂等读取；`close` 是幂等清理。`archive` 依赖 Web 端实际状态，只有观察到指定 conversation 已归档才返回成功。
- `wait` 不设置会关闭 task 或取消远端生成的产品级固定超时。调用环境中断时，Playwright session 和 pending turn 继续存在，后续可再次 `wait`。
- 回复捕获不得依赖未经隔离验证的全局剪贴板。若驱动必须使用 Copy 控件，VER-004 和 VER-006 必须证明并发任务不会读到彼此内容。

### 失败与运行边界

- 输入路径、浏览器动作或本地写入失败时返回具体操作和原因；不得把失败记为 completed，也不得因为失败扫描更多本地文件。
- 不进行自动 prompt 重发、Playwright session 自动重启或 conversation 自动迁移。浏览器进程崩溃时保留 SQLite 状态与已有 transcript，并报告任务不可用；崩溃恢复属于后续规格。
- BEH-008 的进程终止出现部分失败时，保留可定位的进程或 session 信息并返回失败；不删除 transcript 来伪造清理完成。
- task 和 turn 标识必须不可碰撞；prompt 和 response 写入先落到同目录临时文件，再原子替换各自目标文件。已经完成的 `prompt.md` 和 `response.md` 不再覆盖。
- `browser.ts` 是 ChatGPT Web 易变接口的唯一承载层。selector、完成检测、Copy response 和 Archive 必须在固定 Playwright CLI 版本与 live 环境中验证后才能视为已实现。

## 验收与验证

| ID      | 覆盖对象                           | 前置条件                                                  | 执行或检查                                                                                                                                           | 通过证据                                                                                           | 证明边界                                              |
| ------- | ---------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| VER-001 | BEH-001                            | 可交互登录的 Pro 账号与干净认证目录                       | 使用固定 Playwright CLI 登录并 `state-save`；关闭 setup session，从同一 seed state 同时执行两次 `start`                                              | setup session 已关闭；两个非持久 task session 均已登录且未再次请求登录；seed 文件未被 task 改写    | 不证明认证长期不过期                                  |
| VER-002 | BEH-002                            | VER-001 通过                                              | 同时启动两个任务，检查 Playwright session、浏览器进程、browser context 和 session 目录，并分别完成首次发送                                           | 两个不同 named session、浏览器 PID、内存 browser context、taskId、session 路径和 conversation      | 不证明消息并发或回复隔离                              |
| VER-003 | BEH-003 与产品边界                 | 活动任务；当前目录含 dirty Git 状态、未指定文件和 symlink | 从工作区内外各选择明确附件执行 `send`，不传其他文件                                                                                                  | Web 输入与指定内容一致；显式外部路径可上传；未指定文件无读取、打包或上传；返回 turnId              | 不证明 Pro 回复正确                                   |
| VER-004 | BEH-004                            | 已发送包含长文本与代码块、可产生完整回复的 turn           | 执行 `wait`；检查最新 user turn 后的 assistant、`Stop answering` 与 Copy 状态，将页面内拦截的 Copy response 和 `response.md` 逐字节比较，再重复 wait | 仅在完成条件满足后返回；内容一致；没有读取系统剪贴板；重复调用返回同一路径；旧 response 未覆盖     | 只覆盖当次 Web UI 和测试内容                          |
| VER-005 | BEH-005                            | 同一 task 的首个 turn 已完成                              | 发送引用上文的第二个 prompt 并等待                                                                                                                   | conversation 标识不变；第二次回复使用上文；两个 turn 文件独立                                      | 不证明跨任务并发                                      |
| VER-006 | BEH-006                            | VER-002 通过；两个任务可产生回复                          | 对两个 named session 分别 send，不等待第一个完成即并发执行 wait                                                                                      | 两个生成区间重叠；两份回复与 SQLite/文件 transcript 分别归属正确 task；单边失败不停止另一边        | 不证明任意任务规模下的吞吐                            |
| VER-007 | BEH-007                            | 至少两个 completed turn 使用过同名 prompt 来源文件        | 修改原 prompt 文件并检查 SQLite 与 session；关闭任务后用新的 CLI 进程复读                                                                            | task/turn 顺序和附件路径可查询；每份 prompt/response 保持原内容；附件正文没有副本                  | 不保证已修改附件的字节级复原                          |
| VER-008 | BEH-008                            | 活动任务且 Web conversation 已建立                        | 执行 `close` 两次并检查 Playwright session、本地目录与 Web                                                                                           | named session 和浏览器进程消失；SQLite/transcript 与共享 seed 保留；Web 未归档；第二次无额外副作用 | 不证明操作系统能清理被外部程序锁定的文件              |
| VER-009 | BEH-009                            | 活动任务且 Web conversation 已建立                        | 执行 `archive`，等待离开目标 canonical URL，刷新侧栏，再检查指定与其他 conversation 及本地任务                                                       | 刷新后目标 conversation 不在侧栏；进程和 transcript 保持；其他 conversation 不变                   | 只覆盖当次 ChatGPT Web Archive UI                     |
| VER-010 | BEH-001–BEH-009 的确定性实现       | 依赖已安装，目标代码和测试存在                            | 在最后一次相关修改后运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm collab -- help`                                      | 每条命令退出码为 0，测试输出能追溯对应 `BEH-*`                                                     | 不证明真实 ChatGPT Web 行为；不能替代 VER-001–VER-009 |
| VER-011 | BEH-002、BEH-004、BEH-006、BEH-007 | state 实现与测试存在                                      | 以两个进程并发操作不同 task，覆盖 turn 创建、完成和 close；终止进程后重新打开同一数据库                                                              | WAL/事务下无丢失更新或跨 task 污染；状态与文件不变量保持；重启后可读取                             | 不证明浏览器或 ChatGPT Web 行为                       |
| VER-012 | BEH-001–BEH-009 的运行前提         | Node.js v22.19.0、当前受支持 Node、npm/npx 和网络可用     | 分别在最低与当前 Node 执行版本检查、`node:sqlite` DatabaseSync 内存库 smoke test 和最小 `.ts` 入口 smoke test；执行固定 Playwright CLI help          | 两个 Node 版本的 smoke test 与 `npx -y @playwright/cli@0.1.17 --help` 退出码均为 0                 | 不证明登录、storage state 或页面 selector             |

VER-001–VER-012 均为完成本规格的必需验证。VER-001–VER-009 是 live flow，未经真实执行不得以 mock、单元测试或代码审查声称通过。

**相关修改**是指改变任一 `VER-*` 的覆盖行为、组件映射、状态、接口、前置条件、执行步骤或证据判据的变更。全部必需 `VER-*` 必须在最后一次相关修改后重新通过；局部修复至少重跑失败的 `VER-*`、所有受影响的 `VER-*`、VER-010 和 VER-012；涉及 SQLite 状态时还必须重跑 VER-011。

执行前必须重新核对：采用的仍是本文件及其当前版本；阻塞未决事项已经解除；目标仓库中的运行版本、browser dependency、命令入口和测试入口与技术设计一致；工作区已有改动已识别且不会被覆盖或归入本次实现。

失败后按证据分流：实现偏离 `BEH-*` 时修复最小实现根因；测试与 `BEH-*` 冲突时只在直接证据支持下修订测试；ChatGPT Web、权限或环境不可用时记录失败动作和缺失前置，不修改产品代码伪造通过；外部接口或 checkout 漂移时重新取证，若漂移会改变产品行为则暂停并请求用户裁决。

没有新证据，且下一步不会引入新的可验证假设、证据来源或不同修复动作时，停止重复尝试。报告已尝试动作、现有证据、阻塞原因和解除条件；固定重试次数不能替代该判断。

完成条件是：所有 `BEH-*`、产品边界和不可接受结果均有验证覆盖；VER-001–VER-012 在最后一次相关修改后通过；本规格标记为需要直接检查的 SQLite、session 文件、浏览器进程、Playwright session、Web conversation 和 transcript 已实际检查；不存在阻塞未决事项；最终变更未加入仓库理解、patch 集成、兼容迁移或其他规格外能力。

## 决策记录

| 选择                      | 状态   | 理由                                                                                               | 影响                                                                   |
| ------------------------- | ------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 轻量浏览器协作通道        | 已确认 | 旧方向把仓库安全门、集成和生命周期混入传输层，持续阻断正常协作；核心应只剩合作协议和浏览器操作     | BEH-001–BEH-009、产品边界、技术设计                                    |
| 每 task 独立浏览器进程    | 已确认 | 多任务必须能够同时等待和操作，不能由共享浏览器或串行控制互相影响                                   | BEH-002、BEH-006、VER-002、VER-006                                     |
| 宿主显式提供输入          | 已确认 | Collab 不可能可靠理解所有用户项目；文件选择应由掌握任务上下文的宿主负责                            | BEH-003、产品边界、VER-003                                             |
| send 与 wait 分离         | 已确认 | Pro 可能长时间生成；提交不应占住宿主或阻止其他任务继续工作                                         | BEH-003、BEH-004、BEH-006、技术设计                                    |
| 原始回复交给宿主解释      | 已确认 | 固定 response schema、diff 或 receipt 解析会把具体任务协议写死，并制造错误 blocker                 | BEH-004、产品边界、VER-004                                             |
| close 与 Web archive 分离 | 已确认 | 本地进程生命周期与 Web conversation 生命周期是两种独立副作用，必须由不同显式命令触发               | BEH-008、BEH-009、VER-008、VER-009                                     |
| Playwright CLI 浏览器边界 | 已确认 | 固定版本外部 CLI 已提供 session、storage state 和页面命令；无需增加浏览器库封装或运行时 dependency | 技术基线、Browser boundary、VER-001–VER-006、VER-008、VER-009、VER-012 |
| 共享只读 storage state    | 已确认 | 两个非持久 session 可从同一 seed 并发登录且后续状态隔离；复制认证文件不增加运行态隔离              | BEH-001、BEH-002、BEH-006、VER-001、VER-002、VER-006                   |
| SQLite 与正文分离         | 已确认 | 结构化状态需要事务和跨进程查询；prompt/response 正文仍应保持为直接可读、逐 turn 不覆盖的文件       | State store、Artifact store、VER-007、VER-011、VER-012                 |
| 不兼容旧实现              | 已确认 | 迁移旧 task、bundle 和数据库会把已经拒绝的复杂度带回新产品                                         | 产品边界、完成条件                                                     |

## 参考资料

| ID      | 名称                              | 位置                                                                                                                                        | 版本或日期                          |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| REF-001 | Playwright CLI README             | https://github.com/microsoft/playwright-cli/blob/v0.1.17/README.md                                                                          | v0.1.17                             |
| REF-002 | Node.js SQLite API                | https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html                                                                           | Node.js v22.19.0                    |
| REF-003 | Node.js TypeScript type stripping | https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html                                                                       | Node.js v22.19.0                    |
| REF-004 | Playwright CLI storage source     | https://github.com/microsoft/playwright/blob/9fb36027c64c8edcf08bf06f618b3ca97a7b0d97/packages/playwright-core/src/tools/backend/storage.ts | `@playwright/cli@0.1.17` 的锁定依赖 |
