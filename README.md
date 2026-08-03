# ChatGPT Pro Collab

本仓库提供一个 Agent Skill，通过彼此隔离的本地浏览器任务与 ChatGPT Pro Web 持续多轮协作。宿主明确选择 prompt 与附件；Collab 只负责浏览器会话、Web conversation、原始回复和本地审计记录。

## 用法

运行环境需要 Node.js `>=22.19.0`、pnpm、npm/npx、Chrome，以及可交互登录的 ChatGPT Pro 账号。

```sh
pnpm install
pnpm collab -- setup
pnpm collab -- start
pnpm collab -- send <taskId> <promptPath> [attachmentPath ...]
pnpm collab -- wait <taskId> <turnId>
pnpm collab -- archive <taskId>
pnpm collab -- close <taskId>
```

`setup` 保存本机共享认证源。每次 `start` 返回独立 `taskId`；`send` 提交一轮并立即返回 `turnId`；`wait` 在完成后返回原始 `response.md` 路径。同一任务完成一轮后可以继续 send/wait，多个任务可以同时等待。

## 数据

认证源、SQLite 协调状态与逐 turn transcript 保存在 `~/.local/chatgpt-pro-collab/`。附件只从命令明确传入的原路径上传；审计记录保存附件绝对路径，不复制附件正文。

## 边界

Collab 不扫描或理解仓库，不检查 Git 状态或秘密，不应用 Pro 回复，也不执行、提交、合并或发布代码。`close` 只关闭本地浏览器；`archive` 只归档目标 Web conversation。完整行为和验收合同见 [浏览器协作 Spec](docs/specs/2026-08-03-chatgpt-pro-browser-collaboration.md)。
