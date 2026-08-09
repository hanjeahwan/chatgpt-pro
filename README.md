# ChatGPT Pro Collab

本仓库提供一个 Agent Skill，通过彼此隔离的本地浏览器任务与 ChatGPT Pro Web 持续多轮协作。宿主明确选择 prompt 与附件；Collab 只负责浏览器会话、Web conversation、原始回复和本地审计记录。

## 用法

运行环境需要 Node.js `>=22.19.0`、npm/npx、Chrome，以及可交互登录的 ChatGPT Pro 账号。安装后的 Skill 以加载到的 `SKILL.md` 所在绝对目录替换 `<skill-directory>`，并保持宿主项目为当前工作目录：

```sh
node "<skill-directory>/scripts/collab.ts" setup
node "<skill-directory>/scripts/collab.ts" start <taskId>
node "<skill-directory>/scripts/collab.ts" send <taskId> <promptPath> [attachmentPath ...]
node "<skill-directory>/scripts/collab.ts" wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>
node "<skill-directory>/scripts/collab.ts" status <taskId>
node "<skill-directory>/scripts/collab.ts" recover <taskId>
node "<skill-directory>/scripts/collab.ts" resolve-submission <taskId> <turnId> submitted <conversationUrl>
node "<skill-directory>/scripts/collab.ts" resolve-submission <taskId> <turnId> not-submitted
node "<skill-directory>/scripts/collab.ts" resolve-turn <taskId> <turnId> failed
node "<skill-directory>/scripts/collab.ts" archive <taskId>
node "<skill-directory>/scripts/collab.ts" close <taskId>
```

在本源码仓库开发时，先安装 pnpm 依赖，再使用 package script：

```sh
pnpm install
pnpm collab -- setup
pnpm collab -- start <taskId>
pnpm collab -- send <taskId> <promptPath> [attachmentPath ...]
pnpm collab -- wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>
pnpm collab -- status <taskId>
pnpm collab -- recover <taskId>
pnpm collab -- resolve-submission <taskId> <turnId> submitted <conversationUrl>
pnpm collab -- resolve-submission <taskId> <turnId> not-submitted
pnpm collab -- resolve-turn <taskId> <turnId> failed
pnpm collab -- archive <taskId>
pnpm collab -- close <taskId>
```

`setup` 保存本机共享认证源。每次 `start` 需要调用方提供的稳定 canonical UUID v4 `taskId` 并返回同一个 `taskId`；`send` 提交一轮并立即返回 `turnId`。`wait` 使用有限观察窗口：到期时返回 `pending` 且不停止远端生成；完成时返回原始 `response.md` 与按回复顺序保存的 `artifactPaths`。同一 `wait` 内若连续 300000ms 未捕获，Collab 自动 reload 当前 conversation 重新水合页面后继续观察与捕获；reload 只由时间触发，不检查页面完成信号、不终止远端生成、不改变 turn 状态。捕获超时后可用新的 `captureTimeoutMs` 继续同一 turn。`status` 只读返回持久状态与唯一安全的 `nextAction`；`nextAction: none` 只表示没有待继续或待解除的持久工作流，它本身不禁止宿主按用户意图、在当前 task 状态允许时显式执行 `send` 或 `close`；`recover` 按持久阶段恢复中断操作；`resolve-submission` 对无法自动判定的提交歧义接受人工裁决；`resolve-turn ... failed` 只在用户明确确认 response 已失败或终止后裁决旧 turn，continuation 仍由宿主另行显式发送。同一任务完成一轮后可以继续 send/wait，多个任务可以同时等待。

每个新 task 的首条 user message 由宿主把 Skill 中的固定协作合同、当前任务和当轮附件作为同一条消息提交；首次提交前失败时，下一次显式 `send` 仍包含完整合同。`start` 仍只建立空白 composer，不单独发送模式声明。conversation 绑定后的后续 turn 沿用已有上下文，不重复该合同。Collab CLI 不隐式改写 prompt，Web 消息与宿主交给 `send` 的 prompt 文件保持一致。

## 数据

认证源、SQLite 协调状态与逐 turn transcript 保存在 `~/.local/chatgpt-pro-collab/`。附件只从命令明确传入的原路径上传；审计记录保存附件绝对路径，不复制附件正文。回复中的唯一 `sandbox:` 文件保存到各自 turn 的 ordinal 目录；普通 `https:` 链接不下载。

## 边界

Collab 不扫描或理解仓库，不检查 Git 状态或秘密，不应用 Pro 回复，也不执行、提交、合并或发布代码。`close` 只关闭本地浏览器，并把 task 保留为可恢复暂停态：同一 task 的后续 feedback 先 `status`，按 `nextAction` 执行 `recover`，继续原 canonical conversation；`archive` 仍独立。完整行为和验收合同见 [浏览器协作 Spec](docs/specs/2026-08-03-chatgpt-pro-browser-collaboration.md)。
