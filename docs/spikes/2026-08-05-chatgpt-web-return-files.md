# ChatGPT Web 返回文件页面 Spike

本记录回答一个有界决策问题：ChatGPT Pro Web 单个 assistant turn 的 `sandbox:` 返回文件链接如何映射到页面控件和下载事件。只验证 2026-08-05 当日观察到的页面合同，不证明未来页面保持不变；授权范围仅限该页面合同观察，不执行 Collab 的持久化、失败注入或重试，因此不构成 VER-015 整体通过证据。

## 1. 决策问题

- 要决定什么：如何把单 assistant turn 的 `sandbox:` 返回文件链接映射为页面控件与下载事件，形成可实现且可判失败的捕获规则。
- GO 条件（追溯收口判定）：能够形成“位置对应 + artifact 行映射 + 两类下载路径”的无歧义严格映射；重复目标可去重、同名目标可按顺序区分、普通外链可排除；页面数量、顺序或控件关系漂移时有明确失败信号。
- NO-GO 条件（追溯收口判定）：映射存在歧义、需要猜测相邻控件，或关键下载路径无法复现。
- 非目标：不证明 ChatGPT Web 未公开 DOM 是稳定 API；不证明其他账号、模型、文件类型或未来版本具有相同页面结构；不执行 Collab 的 artifact 持久化、失败注入、捕获超时或重试，因此不构成 VER-015 整体通过证据。
- 判定门说明：原始实验是 2026-08-05 当日的 live 页面合同记录，实验前未预先定义 GO/NO-GO 判定门；本结论是基于既有记录在收口时的追溯判定，不是事前定义的实验门槛。

## 2. 实验边界

- 环境与输入：本仓库固定的 `@playwright/cli@0.1.17` 与已有认证源启动独立 ChatGPT Web conversation；观察时间 2026-08-05 00:29–00:34（UTC+08）；conversation `6a721372-26e4-83ec-80e1-e20278881c07`；assistant turn `request-WEB:44cfe041-8044-453f-b73b-d0c3caa705f9-0`；页面记录的模型为 `gpt-5-6-thinking`。
- 允许操作：发送固定 Spike prompt；在目标 assistant turn 内记录 Copy response、链接 DOM、点击行为和下载事件；展开 artifact 区。
- 禁止操作：修改页面或服务端行为、绕过认证、修改 Spec、ADR 或产品实现。
- 停止条件与资源清理：回复完成后停止观察；不保留带时效签名的完整下载 URL；原始证据保留在 conversation/turn 与 session 记录，文档只保留引用和结论。

## 3. 实验方法

1. 启动独立 ChatGPT Web conversation，发送固定 Spike prompt（见下文输入）。
2. 回复完成后，在目标 assistant turn 内记录 Copy response 的 `text/plain` 与 `text/html`。
3. 记录正文 DOM：sandbox href 是否保留、`button.behavior-btn` 的数量与顺序、普通 `<a href>`。
4. 按完整 `sandbox:` 逻辑 URL 去重，展开目标 turn 的 artifact 区并记录行顺序。
5. 对已映射 artifact 行点击同级 `Download file`、对未映射唯一目标点击正文行为按钮，捕获 download event 与浏览器建议文件名。
6. 校验下载内容：字节数、SHA-256、ZIP 解压、PNG 有效性、同名文件内容与摘要。
7. 点击 `page.html` 与 `pixel.png` 的正文行为按钮，区分查看路径与下载路径。

Spike prompt（要求同一回复创建并返回测试产物）：

1. `page.html`：最小有效 HTML。
2. `bundle.zip`：ZIP 内含一个 `marker.txt`。
3. `pixel.png`：有效 PNG 图片。
4. `script.py`：最小 Python 源码。
5. 两个内容不同、父目录不同但 basename 都是 `same-name.txt` 的文件。

回复正文必须按以下顺序提供链接：`page.html`、`bundle.zip`、`pixel.png`、`script.py`、第一个 `same-name.txt`、第二个 `same-name.txt`。然后把 `page.html` 的同一个 sandbox 目标再链接一次，显示文字写成 `page.html duplicate`。最后加入一个普通 HTTPS 链接 `https://example.com/`，显示文字写成 `ordinary https link`。不要把文件合并为一个归档，不要省略任何链接。回复末尾用一句话确认已创建 6 个唯一文件目标、7 个 sandbox 链接和 1 个普通 HTTPS 链接。

## 4. 实验结果

所有行的证据位置均为 conversation `6a721372-26e4-83ec-80e1-e20278881c07`、assistant turn `request-WEB:44cfe041-8044-453f-b73b-d0c3caa705f9-0` 的 session 原始记录；文档不保留带时效签名的完整下载 URL。

| 场景                       | 预期                                                                   | 实际观察                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 证据位置 | 判定 |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- |
| 位置对应与外链排除         | Copy response 与正文按钮按文档顺序一一对应，普通外链不进入文件控制集合 | Copy response 调用一次 `navigator.clipboard.write`，同一 ClipboardItem 同时含 `text/plain` 与 `text/html`；`text/html` 按回复顺序保留 7 个 `sandbox:` anchor、各自显示文字和完整逻辑 URL，另有 1 个 `https://example.com/` anchor。正文 DOM 不保留 sandbox href，按相同文档顺序渲染 7 个 `button.behavior-btn`，普通外链仍是唯一的 `<a href="https://example.com/">`。显示文字不能作为身份：重复 `page.html` 的第二个正文按钮仍显示 `page.html`，未保留 `page.html duplicate` | 同上     | 通过 |
| 重复目标去重               | 重复 sandbox 目标合并为唯一目标                                        | 按完整 `sandbox:` 逻辑 URL 去重后得到 6 个目标；重复 `page.html` 没有产生第二个 artifact 行                                                                                                                                                                                                                                                                                                                                                                                   | 同上     | 通过 |
| artifact 区行序            | artifact 行按首次出现顺序构成唯一 sandbox 目标的子序列                 | artifact 区提供 5 个带 `Open file` 和同级 `Download file` 的行；展开 `2 more` 后顺序为 `page.html`、`pixel.png`、`script.py`、两个 `same-name.txt`；`bundle.zip` 不在该区                                                                                                                                                                                                                                                                                                     | 同上     | 通过 |
| 目标 1/6 `page.html`       | artifact 行的 `Download file` 触发下载                                 | artifact 行 0 `Download file`；建议文件名 `page.html`；127 字节；SHA-256 `f1df93c7ab3883b9d0d0766a2a0066d6e368146d423b29321d27556e3c11fce4`                                                                                                                                                                                                                                                                                                                                   | 同上     | 通过 |
| 目标 2/6 `bundle.zip`      | 未映射目标走正文直接下载                                               | 正文行为按钮 1 直接触发 download event；建议文件名 `bundle(1).zip`；127 字节；SHA-256 `74206c380345fc7a63af67a2eca17a922de7d55237bf2a86a6550d0875b67b5e`；ZIP 可正常解压且只含内容为 `marker` 的 `marker.txt`                                                                                                                                                                                                                                                                 | 同上     | 通过 |
| 目标 3/6 `pixel.png`       | artifact 行的 `Download file` 触发下载                                 | artifact 行 1 `Download file`；建议文件名 `pixel.png`；70 字节；SHA-256 `abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f`；有效 1×1 RGBA 图片                                                                                                                                                                                                                                                                                                                | 同上     | 通过 |
| 目标 4/6 `script.py`       | artifact 行的 `Download file` 触发下载                                 | artifact 行 2 `Download file`；建议文件名 `script.py`；15 字节；SHA-256 `b80792336156c7b0f7fe02eeef24610d2d52a10d1810397744471d1dc5738180`；内容与 prompt 相符                                                                                                                                                                                                                                                                                                                | 同上     | 通过 |
| 目标 5/6 `a/same-name.txt` | 同名目标按顺序区分                                                     | artifact 行 3 `Download file`；建议文件名 `same-name.txt`；21 字节；SHA-256 `ac87be8bf9ed37f5f89ad920b89900eedb2acc3adbcbfd202bac5f453676f527`                                                                                                                                                                                                                                                                                                                                | 同上     | 通过 |
| 目标 6/6 `b/same-name.txt` | 同名目标按顺序区分，不覆盖                                             | artifact 行 4 `Download file`；建议文件名 `same-name(1).txt`；22 字节；SHA-256 `54a995bda879ff1669b7d4544a986321a72dc50a879206505fbcb05a65feb205`；与目标 5 的 content ID、内容与摘要均不同                                                                                                                                                                                                                                                                                   | 同上     | 通过 |
| 下载事件与 URL 来源        | 全部目标均可下载，URL 来自 ChatGPT 下载端点                            | 6 次 download event 均成功，URL 均来自 `/backend-api/estuary/content`；带时效签名的完整下载 URL 不保留                                                                                                                                                                                                                                                                                                                                                                        | 同上     | 通过 |
| 查看路径与下载路径区分     | 正文行为按钮可进入查看路径，artifact 行 `Download file` 触发真实下载   | 点击 `page.html` 或 `pixel.png` 的正文行为按钮没有触发 download event：`page.html` 使用内嵌预览，`pixel.png` 出现以同一 estuary content URL 为源的可见图片；对应 artifact 行的 `Download file` 按钮随后触发真实 download event                                                                                                                                                                                                                                                | 同上     | 通过 |

## 5. 结论

- 判定：GO（追溯收口判定：原始实验未在实验前定义 GO/NO-GO 判定门，本结论基于 2026-08-05 live 记录在收口时判定，判定门见第 1 节）
- 已确认事实：
  - Copy response 的 `text/html` 按回复顺序保留 7 个 `sandbox:` anchor、各自显示文字和完整逻辑 URL，另含 1 个 `https://example.com/` anchor；`text/plain` 保留原始 response。
  - 正文 DOM 不保留 sandbox href，按相同文档顺序渲染 7 个 `button.behavior-btn`；普通外链保持唯一 `<a href>`；显示文字不可作为身份。
  - 按完整逻辑 URL 去重后得到 6 个唯一目标；重复 `page.html` 没有产生第二个 artifact 行。
  - artifact 区展开 `2 more` 后行序为 `page.html`、`pixel.png`、`script.py`、两个 `same-name.txt`；`bundle.zip` 不在该区，由正文行为按钮直接触发 download event。
  - 6 次 download event 均成功且 URL 均来自 `/backend-api/estuary/content`；两个同名文件的 content ID、内容与摘要均不同；ZIP 可解压且只含 `marker.txt`；PNG 为有效 1×1 RGBA；其余文件内容与 prompt 相符。
  - 点击 `page.html`/`pixel.png` 正文按钮进入查看路径（内嵌预览 / 同源 estuary URL 图片），不触发 download event；对应 artifact 行的 `Download file` 触发真实 download event。
- 推断及依据（推断，依据上述已确认事实）：
  1. 从 Copy response 的 `text/html` 按文档顺序提取 `sandbox:` anchor，按完整逻辑 URL 去重并保留首次出现位置；`text/plain` 仍作为原始 response。
  2. 将目标 turn 内按文档顺序出现的 `button.behavior-btn` 与去重前 sandbox anchor 按位置对应；数量不相等时视为页面合同漂移。普通 `<a href>` 不进入该映射。
  3. 展开目标 turn 的 artifact 列表，其行按首次出现顺序构成唯一 sandbox 目标的子序列；用 basename 与顺序把这些行映射为 artifact/viewer 路径，同名目标按顺序区分；无法形成无歧义子序列时视为页面合同漂移。
  4. 对已映射 artifact 行点击其同级 `Download file` 并捕获 download event；对未映射的唯一目标点击其正文行为按钮并捕获直接 download event。浏览器建议文件名和带签名下载 URL 只作为当次事件结果，不作为逻辑身份。
  - 该合同满足重复目标去重、同名目标区分、不同文件类型下载和普通外链排除；实现仍必须在页面数量、顺序或控件关系漂移时失败，不得猜测相邻控件。
- 剩余未知项：
  - 本记录只验证一次真实 Pro conversation 中实际出现的页面结构与浏览器事件，不证明 ChatGPT Web 未公开 DOM 是稳定 API，也不证明其他账号、模型、文件类型或未来版本具有相同页面结构。
  - 本记录没有执行 Collab 的 artifact 持久化、失败注入、捕获超时或重试，因此不构成 VER-015 整体通过证据。
  - artifact 区折叠的更多目标数量与更多顺序变化未验证。

## 6. 交接

- 需要宿主决定的事项：无产品决策缺口；按第 5 节捕获规则继续实现返回文件捕获（对应 Spec BEH-012 / VER-015），并在页面数量、顺序或控件关系漂移时失败。
- 建议路由：继续实施（GO）。
- 已清理和保留的资源：browser/会话已关闭；不可重建的原始页面记录保留在 conversation/turn 与 session，文档只保留引用和结论；带时效签名的完整下载 URL 未保留。

## 7. Spike 交付前检查

- [x] 只回答一个有界决策问题
- [x] 结论满足判定门（判定门未在实验前定义，已如实注明为基于既有记录的追溯收口判定）
- [x] 事实与推断已区分
- [x] 原始证据有稳定位置且文档只保留引用
- [x] 敏感数据已移除
- [x] 临时资源已清理
- [x] 未越权修改 Spec、ADR 或产品实现
