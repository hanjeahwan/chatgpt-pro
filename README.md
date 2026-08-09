# ChatGPT Pro Collab

ChatGPT Pro Collab 是连接本地 Agent 与 ChatGPT Pro Web 的双向协作 Skill。任意一方都可以主导分析和方案：本地 Agent 可以把明确任务交给 Pro；Pro 也可以在自己的沙盒中分析、生成 patch 或文件，再要求本地 Agent apply、测试并回传结果。

双方权限并不对称：Pro 不能直接访问或修改本地仓库，本地 Agent 始终负责本地文件范围、执行和验证。Collab 只负责连接两端、维护会话和保存记录；是否采用 Pro 的结果，仍由本地 Agent 和你决定。

![Codeartz AI 猫代表本地 Agent，把任务和附件送入独立 ChatGPT Pro 会话，并取回原始回复与文件](assets/chatgpt-pro-collab-readme-illustrations/01-collaboration-loop.png)

## 谁负责什么

| 角色               | 职责                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| 你                 | 提出目标，决定允许发送的文件，并决定是否继续、应用、归档或关闭任务           |
| 本地 Agent         | 理解仓库、准备输入；也可执行 Pro 提出的本地操作、apply patch、测试并回传结果 |
| ChatGPT Pro Collab | 管理隔离浏览器、conversation、多轮等待、文件捕获、中断恢复和审计记录         |
| ChatGPT Pro        | 在收到的上下文和沙盒内分析、主导方案、生成 patch 或文件，并提出验证需求      |

## 两种主导方式

**本地 Agent 主导：** 本地 Agent 已有实现方向，把具体审查、研究或生成任务交给 Pro；取回结果后由本地 Agent 判断和集成。

**ChatGPT Pro 主导：** 本地 Agent 提供问题与必要上下文，Pro 决定分析路径，在沙盒中生成 patch 或其他产物；本地 Agent 取回产物，在真实工作区 apply、运行测试，再把错误、diff 或验证结果发回同一 Pro conversation。

```text
本地问题与上下文 → Pro 沙盒分析与产物 → 本地 apply 与验证 → 结果回传 Pro → 继续收敛
```

## 适合什么场景

- 让 ChatGPT Pro 独立审查一个设计、实现或文档，再由本地 Agent 核对结论。
- 把明确选择的代码或资料交给 Pro 深度分析，不暴露整个仓库。
- 在同一个 conversation 中持续追问，保留已经确认的上下文。
- 等待较长生成，并把原始回复与 `sandbox:` 文件保存回本地。
- 同时维护多个彼此隔离的 Pro 协作任务。
- 浏览器关闭或命令中断后，恢复原 task 和原 conversation。

## 使用前提

- 本地 Agent 已加载 `chatgpt-pro-collab` Skill。
- Node.js `>=22.19.0`、npm/npx 和 Chrome 可用。
- 你有可交互登录的 ChatGPT Pro 账号。
- ChatGPT 中存在唯一名为 `chatgpt-pro-collab` 的 Project，并可选择 GPT-5.6 Sol 与 Power 5/5。

首次使用时，告诉本地 Agent：

> 使用 ChatGPT Pro Collab 完成首次设置。

Agent 会打开独立浏览器。你只需在浏览器中完成登录；验证成功后，后续任务复用本机认证源。

## 怎么交给本地 Agent

### 启动一次新协作

直接说明要使用 ChatGPT Pro、当前任务和允许发送的文件：

> 使用 ChatGPT Pro Collab 审查当前实现的恢复逻辑。只发送 `src/recovery.ts` 和 `tests/recovery.test.ts`。等待完成后先总结 findings，不要直接修改代码。

如果希望 Pro 主导，可以这样说：

> 让 ChatGPT Pro 主导修复当前恢复问题。只发送相关实现与测试；允许 Pro 在沙盒生成 patch。本地 Agent 取回后先检查并 apply，运行测试，再把结果回传 Pro 继续收敛。

本地 Agent 会：

1. 生成新的 `taskId`，启动独立 Pro browser session。
2. 把固定协作合同、当前任务和明确选择的附件作为首条消息发送。
3. 保存返回的 `turnId`，在有限观察窗口内等待。
4. 读取原始 `response.md`、patch 和其他返回文件。
5. 按你的授权在真实工作区检查、apply 和测试，再把验证结果发回同一 conversation，或向你报告最终结论。

### 继续同一个 conversation

保留 Agent 返回的 `taskId`，直接给下一轮 feedback：

> 继续 task `<taskId>`，告诉 Pro：只保留已证明的 P1/P2，并为每个 finding 给出最小修复。

Agent 会恢复原 conversation 并执行新的 send/wait，不会重新发送首轮协作合同。

### 管理任务

你也可以直接要求本地 Agent：

- “检查 task `<taskId>` 的状态并按 `nextAction` 恢复。”
- “继续等待 task `<taskId>` 当前 turn，不要重复发送。”
- “暂时关闭 task `<taskId>` 的本地浏览器，保留后续恢复能力。”
- “归档 task `<taskId>` 的 Pro conversation，然后关闭本地浏览器。”

## 中断和人工裁决

![Codeartz AI 猫用持久状态重新缝合到同一个被中断的 ChatGPT conversation](assets/chatgpt-pro-collab-readme-illustrations/02-durable-recovery.png)

Collab 会持久保存 task、turn、operation 和页面证据。进程中断或浏览器丢失后，本地 Agent 先读取 `status`，再按唯一的 `nextAction` 恢复，不会盲目重发。

只有系统无法证明消息是否提交，或你明确确认某个回复已经失败、终止或永久无法捕获时，Agent 才会请你裁决。需要回答的是已经发生的事实，例如：

- “这条消息已经提交，并且页面已有回复。”
- “这条消息没有提交。”
- “这个回复已经失败，放弃该 turn。”

超时、`pending` 或页面 reload 本身不代表失败。

## 输入、输出与职责边界

- 本地 Agent 只发送当前任务明确选择的 prompt 和附件；大量文件会先由 Agent 打包并核对成员。
- Prompt 在 Web 与本地审计副本之间保持逐字一致，因此文件首尾不能有空白，包括终止换行。
- `wait` 到期会返回 `pending`，不会停止 Pro 生成；连续 300000ms 未捕获时会 reload 同一 conversation。
- 完成后返回未经改写的 `responsePath` 和按回复顺序保存的 `artifactPaths`；artifact 可以是 Pro 沙盒生成的 patch、源码、报告或其他文件。
- 普通 `https:` 链接不会下载；只有回复中的 `sandbox:` 文件进入 artifact 捕获。
- Collab 不扫描或理解仓库，不应用 Pro 回复，也不执行、提交、合并或发布代码。

认证源、SQLite 状态、prompt 副本、回复和 artifact 保存在：

```text
~/.local/chatgpt-pro-collab/
```

## Agent 与开发者命令参考

这些命令由加载 Skill 的本地 Agent 调用，普通用户不需要手工编排。`<skill-directory>` 是已加载 Skill 的绝对路径，运行时保持宿主项目为当前目录。

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

在本源码仓库开发时，可以使用 `pnpm collab -- <command>`。完整产品行为、状态合同和验收条件见 [浏览器协作 Spec](docs/specs/2026-08-03-chatgpt-pro-browser-collaboration.md)。
