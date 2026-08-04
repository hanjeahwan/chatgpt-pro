# ChatGPT Web 返回文件页面 Spike

本记录验证 2026-08-05 当日 ChatGPT Pro Web 中，单个 assistant turn 的 `sandbox:` 返回文件链接如何映射到页面控件和下载事件。结论只适用于本次观察到的页面合同，不证明未来页面保持不变。

## 1. 方法

- 使用本仓库固定的 `@playwright/cli@0.1.17` 与已有认证源启动独立 ChatGPT Web conversation。
- 发送下列 prompt，让同一 assistant turn 生成多种文件、重复目标、同名文件与普通外链。
- 回复完成后，限定在目标 assistant turn 内记录 Copy response、链接 DOM、点击行为和下载事件。
- 观察时间：2026-08-05 00:29–00:34（UTC+08）。
- Conversation：`6a721372-26e4-83ec-80e1-e20278881c07`；assistant turn：`request-WEB:44cfe041-8044-453f-b73b-d0c3caa705f9-0`；页面记录的模型为 `gpt-5-6-thinking`。

## 2. Spike prompt

请在同一个回复中创建并返回以下测试产物。必须实际创建文件，不要只贴代码或描述：

1. `page.html`：最小有效 HTML。
2. `bundle.zip`：ZIP 内含一个 `marker.txt`。
3. `pixel.png`：有效 PNG 图片。
4. `script.py`：最小 Python 源码。
5. 两个内容不同、父目录不同但 basename 都是 `same-name.txt` 的文件。

回复正文必须按以下顺序提供链接：`page.html`、`bundle.zip`、`pixel.png`、`script.py`、第一个 `same-name.txt`、第二个 `same-name.txt`。然后把 `page.html` 的同一个 sandbox 目标再链接一次，显示文字写成 `page.html duplicate`。最后加入一个普通 HTTPS 链接 `https://example.com/`，显示文字写成 `ordinary https link`。

不要把文件合并为一个归档，不要省略任何链接。回复末尾用一句话确认已创建 6 个唯一文件目标、7 个 sandbox 链接和 1 个普通 HTTPS 链接。

## 3. 观察结果

Copy response 调用了一次 `navigator.clipboard.write`，同一 ClipboardItem 同时包含 `text/plain` 和 `text/html`。`text/html` 按回复顺序保留了 7 个 `sandbox:` anchor、各自的显示文字和完整逻辑 URL，另有 1 个 `https://example.com/` anchor。

目标 assistant turn 的正文 DOM 没有保留 `sandbox:` href。它按相同文档顺序渲染了 7 个 `button.behavior-btn`；普通 HTTPS 链接仍是唯一的 `<a href="https://example.com/">`。因此每个 sandbox occurrence 可按位置与 Copy response 的 sandbox anchor 一一对应，普通外链不进入文件控制集合。显示文字不能作为身份：重复 `page.html` 的第二个正文按钮仍显示 `page.html`，没有保留 Copy response 中的 `page.html duplicate`。

按完整 `sandbox:` 逻辑 URL 去重后得到 6 个目标。页面的 artifact 区提供 5 个带 `Open file` 和同级 `Download file` 的行；展开 `2 more` 后顺序为 `page.html`、`pixel.png`、`script.py`、两个 `same-name.txt`。`bundle.zip` 不在该区，点击对应正文按钮直接触发 download event；重复 `page.html` 没有产生第二个 artifact 行。

| 首次出现顺序 | Copy response 逻辑目标                             | 页面下载路径                       | 建议文件名         | 字节数 | SHA-256                                                            |
| ------------ | -------------------------------------------------- | ---------------------------------- | ------------------ | ------ | ------------------------------------------------------------------ |
| 1            | `/mnt/data/chatgpt-web-file-spike/page.html`       | artifact 行 0 `Download file`      | `page.html`        | 127    | `f1df93c7ab3883b9d0d0766a2a0066d6e368146d423b29321d27556e3c11fce4` |
| 2            | `/mnt/data/chatgpt-web-file-spike/bundle.zip`      | 正文行为按钮 1 直接 download event | `bundle(1).zip`    | 127    | `74206c380345fc7a63af67a2eca17a922de7d55237bf2a86a6550d0875b67b5e` |
| 3            | `/mnt/data/chatgpt-web-file-spike/pixel.png`       | artifact 行 1 `Download file`      | `pixel.png`        | 70     | `abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f` |
| 4            | `/mnt/data/chatgpt-web-file-spike/script.py`       | artifact 行 2 `Download file`      | `script.py`        | 15     | `b80792336156c7b0f7fe02eeef24610d2d52a10d1810397744471d1dc5738180` |
| 5            | `/mnt/data/chatgpt-web-file-spike/a/same-name.txt` | artifact 行 3 `Download file`      | `same-name.txt`    | 21     | `ac87be8bf9ed37f5f89ad920b89900eedb2acc3adbcbfd202bac5f453676f527` |
| 6            | `/mnt/data/chatgpt-web-file-spike/b/same-name.txt` | artifact 行 4 `Download file`      | `same-name(1).txt` | 22     | `54a995bda879ff1669b7d4544a986321a72dc50a879206505fbcb05a65feb205` |

6 次 download event 均成功，且 URL 都来自 ChatGPT 的 `/backend-api/estuary/content`。表中不保留带时效签名的完整下载 URL；两个同名文件的 content ID、内容和摘要均不同。ZIP 可正常解压且只含内容为 `marker` 的 `marker.txt`；PNG 是有效的 1×1 RGBA 图片；其余文件内容与 prompt 相符。

点击 `page.html` 或 `pixel.png` 的正文行为按钮没有触发 download event，而是进入页面查看路径：`page.html` 使用内嵌预览，`pixel.png` 出现以同一 estuary content URL 为源的可见图片。对应 artifact 行的 `Download file` 按钮随后触发真实 download event。该结果区分了正文直接下载路径、artifact/viewer 下载路径和普通外链。

## 4. 页面合同结论

当前页面可用下列严格映射捕获目标 turn 的返回文件：

1. 从 Copy response 的 `text/html` 按文档顺序提取 `sandbox:` anchor，按完整逻辑 URL 去重，并保留首次出现位置；`text/plain` 仍作为原始 response。
2. 将目标 turn 内按文档顺序出现的 `button.behavior-btn` 与去重前 sandbox anchor 按位置对应；数量不相等时视为页面合同漂移。普通 `<a href>` 不进入该映射。
3. 展开目标 turn 的 artifact 列表；其行按首次出现顺序构成唯一 sandbox 目标的子序列。用 basename 与顺序把这些行映射为 artifact/viewer 路径；同名目标按顺序区分。无法形成无歧义子序列时视为页面合同漂移。
4. 对已映射 artifact 行点击其同级 `Download file` 并捕获 download event；对未映射的唯一目标点击其正文行为按钮并捕获直接 download event。浏览器建议文件名和带签名下载 URL 只作为当次事件结果，不作为逻辑身份。

该合同满足重复目标去重、同名目标区分、不同文件类型下载和普通外链排除；实现仍必须在页面数量、顺序或控件关系漂移时失败，不得猜测相邻控件。

## 5. 证明边界

- 本记录验证一次真实 Pro conversation 中实际出现的页面结构与浏览器事件。
- 本记录不证明 ChatGPT Web 的未公开 DOM 是稳定 API，也不证明其他账号、模型、文件类型或未来版本具有相同页面结构。
- 本记录没有执行 Collab 的 artifact 持久化、失败注入、捕获超时或重试，因此不构成 VER-015 整体通过证据。
