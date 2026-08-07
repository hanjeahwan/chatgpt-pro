---
name: chatgpt-pro-collab
description: 当用户明确要求通过 ChatGPT Pro Web 协作处理当前本地仓库，或需要启动、继续、等待、归档、关闭多个相互隔离的 Pro Web 协作任务时使用。宿主 Agent 明确选择 prompt 与附件；本 Skill 只维护浏览器会话、原始回复和逐 turn 审计记录，不理解仓库、不应用回复、不提交代码。
---

# ChatGPT Pro Collab

加载本 Skill 时，以 `SKILL.md` 所在绝对目录替换下列命令中的 `<skill-directory>`。保持宿主项目为当前工作目录，直接执行 `node "<skill-directory>/scripts/collab.ts" <command>`；不要切换到 Skill 目录，也不要调用宿主项目的 package script。把返回的 `taskId`、`turnId`、`responsePath` 和 `artifactPaths` 作为后续宿主流程的显式输入。

## 1. 完成一次设置

首次使用或认证失效时运行：

```sh
node "<skill-directory>/scripts/collab.ts" setup
```

等待用户在打开的浏览器中完成登录。命令成功后设置浏览器会关闭；后续任务复用本机认证源。

## 2. 启动任务

```sh
node "<skill-directory>/scripts/collab.ts" start
```

保存返回的 `taskId`。每次 `start` 都创建独立浏览器进程、context、session 目录和新 conversation；不要因同项目已有任务而复用或拒绝新任务。

## 3. 准备本轮输入

先把本轮文字输入写入单独的 prompt 文件，再明确列出本轮所需附件。少量文件直接上传；大量文件由宿主 Agent 先生成一个归档，Collab 不扫描或补充归档内容。

代码任务默认生成 `.tar.gz`。在 macOS 使用 bsdtar 时必须同时关闭 copyfile 元数据和 xattr：

```sh
COPYFILE_DISABLE=1 tar --no-xattrs -czf <archive.tar.gz> <selected-path>...
tar -tzf <archive.tar.gz>
```

跨平台交付、任务约定或接收方需要 ZIP 时生成 `.zip`：

```sh
zip -X <archive.zip> <selected-path>...
unzip -Z1 <archive.zip>
```

归档只包含明确选择的 regular file 及承载其相对路径所需的目录项。生成后必须列出成员并与本轮选择结果核对；不要添加 manifest、固定顶层目录、哈希或回复协议，除非当前协作任务本身需要。

## 4. 发送并等待一轮

把直接附件或核对后的单个归档作为普通 `attachmentPath` 传给 `send`：

```sh
node "<skill-directory>/scripts/collab.ts" send <taskId> <promptPath> [attachmentPath ...]
node "<skill-directory>/scripts/collab.ts" wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>
```

`send` 返回 `turnId` 后即可操作其他任务；不要等待时再次发送同一任务。两个时长都必须是有限正整数毫秒值：观察窗口只约束回复生成，捕获超时约束已完成回复的文字与返回文件落盘。

每个观察窗口只调用一次 `wait`，不要在调用尚未返回时另行轮询浏览器。结果为 `pending` 时，远端生成与本地任务保持活动；需要继续观察时，再由宿主显式发起一个新窗口。结果为 `completed` 时读取原始 `response.md` 和 `artifactPaths`，由宿主决定如何解释、验证或使用；不要让 Collab 自动执行回复内容。捕获超时会返回错误，后续 `wait` 使用新的 `captureTimeoutMs` 继续同一 turn。前一轮完成后，可在同一 `taskId` 再次 send/wait 以保留 conversation 上下文。

## 5. 检查与恢复中断状态

任务异常、进程中断或结果不明时，先运行只读检查：

```sh
node "<skill-directory>/scripts/collab.ts" status <taskId>
```

`status` 返回任务、未完成 turn、未完成 operation、浏览器 session 可用性和唯一安全的 `nextAction`。`nextAction` 只可能是 `setup | start | send | wait | recover | resolve-submission | close | none` 之一，按它继续：

- `wait`：对 `pending` 或 `capturing` turn 使用原参数合同再次 `wait`。
- `close`：任务正在关闭，只执行 `close`，不要重建浏览器。
- `recover`：执行恢复命令，由系统按持久阶段和页面证据继续启动、发送准备、浏览器重建或归档恢复：

  ```sh
  node "<skill-directory>/scripts/collab.ts" recover <taskId>
  ```

- `resolve-submission`：消息是否提交无法自动证明时，先检查页面，再由用户提供裁决；两个裁决命令都会先在已登录页面验证，再改变本地状态：

  ```sh
  node "<skill-directory>/scripts/collab.ts" resolve-submission <taskId> <turnId> submitted <conversationUrl>
  node "<skill-directory>/scripts/collab.ts" resolve-submission <taskId> <turnId> not-submitted
  ```

  `submitted` 必须提供无 query、fragment 和凭据的 `https://chatgpt.com/c/<conversationId>` canonical URL；Collab 验证其属于唯一 `chatgpt-pro-collab` Project、与已保存 prompt 及附件名称一致且唯一后，才把原 turn 置为 `pending`。`not-submitted` 只在页面恢复为安全 composer（已绑定 conversation 或唯一目标 Project 的空白 composer）且锚点之后没有匹配提交时，才把原 turn 置为 `failed`，之后由宿主显式重新 `send`。两个分支都不会自动发送消息。

## 6. 管理生命周期

```sh
node "<skill-directory>/scripts/collab.ts" archive <taskId>
node "<skill-directory>/scripts/collab.ts" close <taskId>
```

仅在用户明确要求归档 Web conversation 时运行 `archive`；它不会关闭本地任务。任务不再需要浏览器时运行 `close`；它不会归档 Web conversation，也不会删除 transcript 或共享认证源。

## 7. 遵守输入与失败边界

- 只传入宿主明确指定且当前可读的路径；只有宿主 Agent 可以按第 3 节打包已选输入，Collab 运行时不得扫描、打包或自动补充仓库文件。
- 把附件视为不透明文件；不要因 dirty worktree、symlink、仓库外路径或旧任务增加 Collab 安全门。
- 不要求归档使用 manifest、固定目录结构或固定协作协议；Pro 在沙盒中自行解压，Collab 不发送额外解压消息。
- `unknown-submission` 表示无法证明消息是否已提交；不要自动重发，先执行 `status`，按 `resolve-submission` 分支向用户报告并请求裁决。
- 浏览器、页面 selector、写入或状态不一致时，报告真实错误；不要重启、迁移 conversation、删除 transcript 或伪造成功。

## 8. 结束前检查

- [ ] 本轮 prompt 和每个附件是否都由宿主明确选择？
- [ ] 使用归档时，是否只包含已选输入，并已核对实际成员？
- [ ] 是否保存了每次成功返回的 `taskId`、`turnId`、`responsePath` 和 `artifactPaths`？
- [ ] 是否在读取原始回复后由宿主独立验证，而未让 Collab 自动执行？
- [ ] 中断或结果不明时，是否先执行 `status` 并按 `nextAction` 继续，而不是盲目重发或重启？
- [ ] 是否只在用户明确要求时归档 conversation？
- [ ] 不再使用的活动任务是否已显式关闭？

完成条件：目标协作轮次有独立、可审计的 prompt 与 response；浏览器和 Web conversation 生命周期分别按用户意图处理；中断状态可检查、可恢复、可裁决。
