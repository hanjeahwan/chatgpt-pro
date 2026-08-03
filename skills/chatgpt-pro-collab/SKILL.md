---
name: chatgpt-pro-collab
description: 当用户明确要求通过 ChatGPT Pro Web 协作处理当前本地仓库，或需要启动、继续、等待、归档、关闭多个相互隔离的 Pro Web 协作任务时使用。宿主 Agent 明确选择 prompt 与附件；本 Skill 只维护浏览器会话、原始回复和逐 turn 审计记录，不理解仓库、不应用回复、不提交代码。
---

# ChatGPT Pro Collab

使用 `pnpm collab -- <command>` 维护彼此隔离的 ChatGPT Pro Web 任务。把返回的 `taskId`、`turnId` 和 `responsePath` 作为后续宿主流程的显式输入。

## 1. 完成一次设置

首次使用或认证失效时运行：

```sh
pnpm collab -- setup
```

等待用户在打开的浏览器中完成登录。命令成功后设置浏览器会关闭；后续任务复用本机认证源。

## 2. 启动任务

```sh
pnpm collab -- start
```

保存返回的 `taskId`。每次 `start` 都创建独立浏览器进程、context、session 目录和新 conversation；不要因同项目已有任务而复用或拒绝新任务。

## 3. 发送并等待一轮

先把本轮文字输入写入单独的 prompt 文件，再只列出用户或宿主明确选择的附件：

```sh
pnpm collab -- send <taskId> <promptPath> [attachmentPath ...]
pnpm collab -- wait <taskId> <turnId>
```

`send` 返回 `turnId` 后即可操作其他任务；不要等待时再次发送同一任务。`wait` 返回 `responsePath` 后读取原始 `response.md`，由宿主决定如何解释、验证或使用；不要让 Collab 自动执行回复内容。前一轮完成后，可在同一 `taskId` 再次 send/wait 以保留 conversation 上下文。

## 4. 管理生命周期

```sh
pnpm collab -- archive <taskId>
pnpm collab -- close <taskId>
```

仅在用户明确要求归档 Web conversation 时运行 `archive`；它不会关闭本地任务。任务不再需要浏览器时运行 `close`；它不会归档 Web conversation，也不会删除 transcript 或共享认证源。

## 5. 遵守输入与失败边界

- 只传入宿主明确指定且当前可读的路径；不要扫描、打包或自动补充仓库文件。
- 把附件视为不透明文件；不要因 dirty worktree、symlink、仓库外路径或旧任务增加 Collab 安全门。
- `unknown-submission` 表示无法证明消息是否已提交；不要自动重发，先向用户报告并决定后续处理。
- 浏览器、页面 selector、写入或状态不一致时，报告真实错误；不要重启、迁移 conversation、删除 transcript 或伪造成功。

## 6. 结束前检查

- [ ] 本轮 prompt 和每个附件是否都由宿主明确选择？
- [ ] 是否保存了每次成功返回的 `taskId`、`turnId` 和 `responsePath`？
- [ ] 是否在读取原始回复后由宿主独立验证，而未让 Collab 自动执行？
- [ ] 是否只在用户明确要求时归档 conversation？
- [ ] 不再使用的活动任务是否已显式关闭？

完成条件：目标协作轮次有独立、可审计的 prompt 与 response；浏览器和 Web conversation 生命周期分别按用户意图处理。
