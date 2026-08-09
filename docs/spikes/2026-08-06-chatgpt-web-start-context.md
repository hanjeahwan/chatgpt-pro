# ChatGPT Web Start 上下文 Spike

本记录验证一个有界决策问题：Collab `start` 能否在返回前，可靠建立“已有 `chatgpt-pro-collab` Project 的新 conversation + 指定模型族 + 指定模式”页面上下文。默认 Project 名、缺失时只建议用户且不自动创建，均来自实验前产品约束；实验完成后，用户进一步确认模型固定为 `GPT-5.6 Sol`、模式固定为 `Pro`，且不要求改变自动化浏览器语言。本 Spike 不修改 Spec 或实现。

> **Superseded**：本文关于固定 `Pro` mode 的结论仅保留为 2026-08-06 的历史证据；该结论已由 Spec 的 `GPT-5.6 Sol + Power 5/5` 启动合同替代。

## 1. 决策问题

- 要决定什么：能否用可精确定位、可回读验证、失败时不猜测的页面合同，让 `start` 进入指定已有 Project 的新对话入口，并选择调用方要求的模型族与模式。
- GO 条件：
  - 在 Project 目录内按精确名称能把目标收敛为唯一一行，不依赖列表位置或模糊文本。
  - 进入目标后能同时验证稳定的 Project 路径、Project 身份和新对话编辑器，重新加载后仍成立。
  - 模型族与模式能够独立精确选择，并能从页面状态回读验证选择结果。
  - 目标缺失或不唯一时可以停止并给出人工创建、重命名或检查登录账号的建议；不需要自动创建 Project。
- NO-GO 条件：任一必要维度只能依赖列表位置、模糊相邻文本或不可回读的点击结果；或者进入目标上下文必须创建、修改或删除 Project。
- INCONCLUSIVE 条件：认证页面、目标 Project 或选择控件不可用，导致无法完成选择、回读和恢复实验。
- 非目标：不设计可配置的 Project、模型或模式参数；不发送 prompt；不证明 ChatGPT Web 未公开页面合同未来保持不变；不修改 Spec、ADR、产品实现或运行时账本。

## 2. 实验边界

- 环境与输入：2026-08-06（Asia/Kuala_Lumpur），本仓库固定的 `@playwright/cli@0.1.17`、既有认证状态、Project `chatgpt-pro-collab`；Collab task `dbcd4804-0a80-4e63-98b8-6e3ce3741dd9`。当次自动化页面为英文；用户提供的中文界面截图只用于确认产品意图，不作为 GO 证据。
- 允许操作：访问 ChatGPT 首页与 `/projects`；按精确 Project 名定位并进入目标；读取 URL、标题、无障碍角色和选择状态；在未发送消息前临时切换模型族与模式，并恢复原选择；重新加载目标页。
- 禁止操作：发送消息；创建、修改、重命名、共享、归档或删除 Project；进入既有 conversation 作为 `start` 结果；修改 Spec、ADR、产品实现或运行时账本。
- 停止条件与资源清理：完成“唯一定位、进入、重新加载、独立选择、回读、恢复”后停止。最终恢复 `GPT-5.6 Sol + Pro`，关闭 task；只保留裁剪后的 Project 新对话入口和选择菜单截图，删除包含无关页面内容的宽幅临时截图。

## 3. 实验方法

1. 用 `pnpm collab -- start` 启动独立 task，不发送 prompt。
2. 从 ChatGPT 首页进入 `/projects`，先比较页面全局精确文本匹配与 `role=row` 范围内精确项目名匹配，排除侧栏和既有对话中的同名文本。
3. 要求目标 Project 行数量严格等于 1；点击该行的非操作菜单区域，记录目标 URL、页面标题、Project 标题控件与新对话编辑器。
4. 重新加载目标 URL，再次核对 Project 身份、新对话编辑器和模式入口。
5. 用一个不存在的精确 Project 名执行同一行查询，确认结果为 0；不点击页面的 `New project` 控件。
6. 打开 composer 选择器，记录模式集合、模型子菜单、角色和 `aria-checked` 状态。
7. 将模型从 `GPT-5.6 Sol` 临时切换为 `GPT-5.5`，回读选择状态后恢复；将模式从 `Pro` 临时切换为 `High`，回读选择状态后恢复。
8. 记录最终 URL、编辑器和选择状态，保存裁剪截图并关闭 task。

## 4. 实验结果

证据位置：task `dbcd4804-0a80-4e63-98b8-6e3ce3741dd9` 的执行 transcript 与 `~/.local/chatgpt-pro-collab/sessions/dbcd4804-0a80-4e63-98b8-6e3ce3741dd9/playwright/`；其中 `project-new-chat-context.png` 只保留 Project 标题、空白 composer 和选择入口，`model-mode-menu.png` 只保留两级选择菜单。

| 场景                 | 预期                                            | 实际观察                                                                                                                                                                   | 证据                                       | 判定 |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---- |
| 唯一定位已有 Project | 精确名称在 Project 行范围内收敛为 1，不使用位置 | 页面全局有 9 个可见 `chatgpt-pro-collab` 精确文本节点，但 `role=row` + 精确项目名只匹配 1 行；该行同时含精确名称与 `Open project options for chatgpt-pro-collab`           | transcript                                 | 通过 |
| 目标缺失             | 查询结果为 0，流程可在创建前停止                | 不存在的精确项目名在 `role=row` 范围内返回 0；实验未调用 `New project`                                                                                                     | transcript                                 | 通过 |
| Project 新对话身份   | 进入后能区别于首页和既有 `/c/...` conversation  | 进入后 URL 为 `/g/g-p-6a72a51fc0ac81919292bcd8e256bb56/project`，标题为 `ChatGPT - chatgpt-pro-collab`，且唯一可见 textbox 的无障碍名称为 `New chat in chatgpt-pro-collab` | transcript、`project-new-chat-context.png` | 通过 |
| 重新加载后复核       | Project 身份和空白新对话入口仍成立              | 重新加载前后 URL、标题与唯一 textbox 均一致，模式入口仍可见                                                                                                                | transcript                                 | 通过 |
| 模型族与模式分离     | 两个维度可独立观察和选择                        | 第一层 `menuitemradio` 为 `Instant 5.5`、`Medium`、`High`、`Extra High`、`Pro`；独立模型子菜单为 `GPT-5.6 Sol`、`GPT-5.5`、`GPT-5.3`、`o3`                                 | transcript、`model-mode-menu.png`          | 通过 |
| 模型选择与回读       | 精确选择后状态可验证，并可恢复                  | `GPT-5.6 Sol → GPT-5.5 → GPT-5.6 Sol` 均通过对应 `menuitemradio[aria-checked=true]` 回读；composer 入口随中间状态显示 `5.5 Pro`，恢复后显示 `Pro`                          | transcript                                 | 通过 |
| 模式选择与回读       | 精确选择后状态可验证，并可恢复                  | `Pro → High → Pro` 均通过对应 `menuitemradio[aria-checked=true]` 回读；最终模型子菜单仍显示 `GPT-5.6 Sol`                                                                  | transcript                                 | 通过 |
| 副作用与清理         | 不产生 conversation 或 Project 变更             | 未填写 composer、未发送 prompt、未调用 Project 创建或管理操作；task 成功关闭，最终选择恢复为 `GPT-5.6 Sol + Pro`                                                           | transcript、task close 结果                | 通过 |

## 5. 结论

- 判定：GO。
- 已确认事实：
  - `/projects` 页面不能直接依赖全局同名文本；把精确项目名限定在 `role=row` 后，本次目标唯一且可进入。
  - Project 新对话入口可由三项共同确认：`/g/g-p-<id>/project` 路径、精确 Project 标题、`New chat in <project>` textbox。重新加载后合同仍成立。
  - 模型族与模式是两个独立选择维度；两者都使用 `menuitemradio` 和 `aria-checked` 暴露可回读状态，不需要从按钮显示文本猜测组合。
  - 精确目标缺失时查询自然返回 0；完成该失败判断不需要创建 Project。
- 推断及依据：
  1. `start` 可以先进入 Project 目录，将精确项目名限定在 Project 行内并要求计数严格等于 1；随后进入该行，再用路径、Project 标题和空白新对话 textbox 共同复核身份。
  2. 对调用方指定的模型族与模式，应分别在各自 radio 集合中精确匹配、选择并回读 `aria-checked=true`；任一值不存在或无法唯一匹配时失败，不应退回近似选项。
  3. 默认 Project 可以是已决定的 `chatgpt-pro-collab`；目标缺失或不唯一时应给出人工创建、重命名或检查登录账号的建议，并停止，不调用页面的 Project 创建流程。
  4. 页面合同未公开，代码应在角色、唯一性、路径或回读条件漂移时明确失败，而不是改用列表位置或模糊文本继续执行。
- 剩余未知项：
  - 当次自动化页面为英文；实现能否在其他页面语言下继续仅使用角色、层级、URL、固定目标值和选择状态，需要由实现测试与 live 验证覆盖，不构成浏览器语言产品选项。
  - 本次只验证一个账号、一个现有 Project 和当前可见选项；不保证其他账号权限、未来模型列表或 ChatGPT Web 改版保持相同结构。

## 6. 交接

- 已决定的产品约束：`start` 从已有 `chatgpt-pro-collab` Project 的新 conversation 开始，模型固定为 `GPT-5.6 Sol`，模式固定为 `Pro`；找不到或不能唯一识别 Project，或者固定模型与模式无法选择并回读时，返回错误并建议用户处理，不自动创建 Project，也不改变用户或浏览器语言。
- 需要宿主决定的事项：无。
- 建议路由：更新 Spec。Spec 应描述产品行为和失败合同，页面角色、选择器与本次观测选项保留为实现依据，不把当前完整选项列表承诺为长期产品枚举。
- 已清理和保留的资源：task 已关闭；模型与模式已恢复；未创建 conversation 或 Project；宽幅临时截图已删除，只保留两张裁剪证据；Spike 实验阶段未修改 Spec、ADR、产品实现或运行时账本。

## 7. Spike 交付前检查

- [x] 只回答一个有界决策问题
- [x] 结论满足预先定义的判定门
- [x] 事实与推断已区分
- [x] 原始证据有稳定位置且文档只保留引用
- [x] 敏感数据已移除
- [x] 临时资源已清理
- [x] 未越权修改 Spec、ADR 或产品实现
