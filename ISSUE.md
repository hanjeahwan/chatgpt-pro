# chatgpt-pro-collab 已知问题与待查根因

本文交给接手的 Agent 定位剩余问题。按 [`PROBLEM_FIXING.md`](./PROBLEM_FIXING.md) 执行：先复现建立基线，再单点修改单点验证。

事实与推断在文中分开标注。凡写「实测」的都有当次观测数据，凡写「推断」的都未经验证。

## 待查：capture 阶段超时（唯一未解决）

### 症状

`wait` 走完 observe 阶段后卡在 capture，最终抛 `CAPTURE_TIMEOUT`。同一 turn 用 240000ms 与 480000ms 两个 capture 超时各试一次，均失败。抛出点在 [`collab.ts:1076`](./skills/chatgpt-pro-collab/scripts/collab.ts) 与 `:1084`。

被捕获的助手回复本身是**完整且正常的**——用独立浏览器直接读页面可以拿到全文。所以故障只在捕获链路，不在远端生成。

### 捕获机制

见 `browser.ts` 的 `captureResponseScript`（`copySelector` 定义在 `:3351`）：

1. 定位目标助手 turn，取 `[data-testid="copy-turn-action-button"]`，要求唯一且可见，否则抛 `page contract drift: assistant Copy response is not unique and visible`（`:3385`）。
2. 在页面里改写 `navigator.clipboard.write` 与 `writeText`，把内容截获到 `globalThis.__chatgptProCollabClipboard.captured`（`:3396` 起）。
3. 点击该按钮，`waitForFunction` 等 `captured !== undefined`。
4. 要求 `plain` 与 `html` 都是字符串，否则抛 drift。

超时发生在第 3 步：**桩没有被调用**。第 1 步没有抛 drift，说明选择器当时确实唯一且可见。

### 已排除

**拦截机制本身没坏。** 在一个独立浏览器里对同一条已完成的助手回复做了对照实验：用同样的方式改写 `clipboard.write`/`writeText`，再点击可访问性树里的 `Copy response` 按钮，桩被触发，记录到一次 `write` 调用。

所以问题不是「ChatGPT 换了复制实现」或「页面缓存了原始 clipboard 引用」，而是 collab 自己那个浏览器上下文里的某个条件不同。

### 三条待验证的线索

**线索 A：点击落到了别的按钮。** 实测同一条已完成回复里有三个复制类按钮：`Copy table` ×2 与 `Copy response` ×1（回复正文含 Markdown 表格时出现）。`copySelector` 用的是 `data-testid`，而**这三个按钮各自的 `data-testid` 尚未核实**。若表格复制按钮也带同一个 testid，唯一性检查应当先抛 drift 而不是超时，所以它们大概率 testid 不同——但这一点必须实测确认，不能推断。

验证方式：在一条含表格的已完成助手 turn 上，列出 `[data-testid="copy-turn-action-button"]` 的全部匹配元素及其 `aria-label`。

**线索 B：撞上周期性 reload。** `wait` 会在同一 turn 连续 `OBSERVATION_RELOAD_PERIOD_MS`（300000ms，[`collab.ts:42`](./skills/chatgpt-pro-collab/scripts/collab.ts)）未捕获时 reload 会话页面。reload 会清掉注入的桩。480000ms 那次必然撞上；**但 240000ms 那次不会**，所以 reload 至多解释一半现象，不是完整根因。

**线索 C：点击未真正派发。** `copy.click({ force: true, timeout })`。`force: true` 会跳过可操作性检查，若按钮被覆盖或处于未挂载的虚拟化区域，点击可能不触发其 React 处理器。回复很长时（本例助手回复约 19KB，整页文本约 111KB）该 turn 可能处于折叠或虚拟化状态。

验证方式：在桩里同时记录一次 `pointerdown`/`click` 事件监听，区分「按钮没被点到」与「点到了但处理器没调 clipboard」。

### 复现材料

任务 `5829f1f9-8068-428b-a0a2-b5600e644b32`、会话 `6a8942c4-cde0-83ec-b643-846e655992dd` 下已有多条长助手回复可复现。失败 turn 为 `45b6358a-63c6-413c-949d-13a2beb69a7b`，已按用户裁决标为 `failed`。

## 已修复：六个根因

以下均已提交并推送，`pnpm run check` 全绿（353 tests）。列在此处是因为它们共同说明了这套页面契约的脆弱点，接手时可作为模式参考。

### 1. 符号链接下 CLI 静默失效 — `e264756`

`collab.ts` 末尾的入口守卫用 `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`。Node 默认把 `import.meta.url` 解析到链接目标，而 `resolve()` 不解析符号链接。宿主按 SKILL.md 指定的 `.claude/skills/<name>/scripts/collab.ts` 路径调用时两者不等，`runCli` 不执行——**任何命令都无输出且退出码 0**。

修法：`realpathSync(resolve(...))`。回归测试经链接目录调 `help`。

### 2. 附件 chip 按文本识别 — `f559f14`

`readUserTurnEvidence` 原先把「文本等于附件名的叶子」当作 chip，再向上找容器直到容器包含多于一个叶子。当 prompt 正文里以行内代码写了附件文件名时，正文中的 `<code>` 被判为 chip，容器上溯一路走到包住整条消息的元素，于是正文全部叶子被当成 chip 内容跳过。

实测后果：附件识别出两个（实际一个），正文拼接长度为 0。

修法：改为结构化定位——先找「文本恰好等于 expected 的最深元素」作为正文容器，附件 chip 必然在其之外。

### 3. user 消息存在两种有损渲染 — `2af6610`

实测同一会话的两条 user 消息渲染方式不同：

|          | 消息 A                               | 消息 B                     |
| -------- | ------------------------------------ | -------------------------- |
| 行内代码 | 渲染为 `<code>`，反引号不进 DOM 文本 | 保留反引号，无 `CODE` 元素 |
| 空行     | `\n\n` 保留                          | `\n\n` 塌缩为 `\n`         |

量化：消息 A 正文 textContent 长度 4239 = prompt 4351 − 112 个反引号；消息 B 归一化（去反引号 + 折叠空白）后 3633，与 prompt 归一化结果逐字一致。

所以对原始 prompt 做逐字比对在任一模式下都不成立。修法：两侧同样去掉反引号并折叠空白**但不 trim**——保留首尾空白的差异，使「页面 trim 掉首尾空白时不得声称逐字匹配」这条既有不变量继续成立（`browser.test.ts` 有两个测试专门守它）。

### 4. 只等锚点，不等被验证的 turn — `4b52e4d`

送出时的 auto-verify 与事后 `resolve-submission` 都只 `waitForFunction` 等锚点 turn 出现，随即读取证据。新 turn 可能尚未渲染，导致候选数为 0，报 `submitted user turn could not be verified: zero or multiple matching user turns after the recorded anchor`。

### 5. 证据可读性竞态 — `d906573`（同 commit 含第 6 项）

第 4 项的修法仍不够：settle 条件是「锚点之后存在 user turn」，用的是同一个 `visible()`（依赖 `getClientRects().length > 0`）。turn 元素可见时即返回，而其内层正文容器可能还没完成布局。

实测证据，同一页面同一 turn：刚加载时正文容器候选数为 0；等待数秒后再查，容器 `visible: visible`、`rects: 1`、归一化长度 3633。这也解释了当时的矛盾现象——`not-submitted` 报「找到匹配的已提交 turn」而 `submitted` 报「匹配数不为 1」，两条命令跑在布局的不同时刻。

修法：settle 条件改为**等 matcher 自己匹配成功**（把 `readUserTurnEvidence` 嵌进 `waitForFunction`），20000ms 有界，超时落回原判定。未提交的 prompt 永远不匹配，因此超时是预期路径。

### 6. EPERM 被当成清理失败 — `d906573`

`processGroupAlive` 用 `process.kill(-pid, 0)` 探活，只把 `ESRCH` 当作不存在，`EPERM` 直接抛出。`EPERM` 意味着进程组存在但属于别的用户——即守护进程退出后 PID 被回收复用，那就不是本进程启动的浏览器。把它当作「还活着」会让 `close` 失败、任务永久卡在 `closing`。`killIfAlive` 同理。

修法：两处都把 `EPERM` 与 `ESRCH` 同等处理。回归测试打桩 `process.kill` 抛 `EPERM`，断言 `terminateBrowserDaemon` 正常返回。

## 贯穿性观察

这六个根因里有四个是同一类：**把「页面上读到的东西」直接当成事实，而没有区分「尚未渲染」「渲染方式不同」与「确实不存在」**。ChatGPT 的 DOM 在这三方面都会变化，而当前实现大量依赖 `getClientRects()` 判可见、依赖 `textContent` 逐字比对、依赖 `data-testid` 唯一性。

接手 capture 问题时建议沿这条线索找：捕获同样依赖 testid 唯一性与点击可达性，而它面对的是**整页最长的那个元素**。
