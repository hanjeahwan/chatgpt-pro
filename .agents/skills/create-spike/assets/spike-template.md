# <主题> Spike

<一句说明待验证的决策问题、授权范围和非目标。>

## 1. 决策问题

- 要决定什么：{{DECISION_QUESTION}}
- GO 条件：{{GO_CONDITIONS}}
- NO-GO 条件：{{NO_GO_CONDITIONS}}
- 非目标：{{NON_GOALS}}

## 2. 实验边界

- 环境与输入：{{ENVIRONMENT_AND_INPUTS}}
- 允许操作：{{ALLOWED_OPERATIONS}}
- 禁止操作：{{FORBIDDEN_OPERATIONS}}
- 停止条件与资源清理：{{STOP_CONDITIONS_AND_CLEANUP}}

## 3. 实验方法

按顺序记录最小实验步骤、观察窗口和证据采集方式：{{EXPERIMENT_STEPS}}

## 4. 实验结果

| 场景         | 预期         | 实际观察     | 证据位置              | 判定        |
| ------------ | ------------ | ------------ | --------------------- | ----------- |
| {{SCENARIO}} | {{EXPECTED}} | {{OBSERVED}} | {{EVIDENCE_LOCATION}} | {{VERDICT}} |

## 5. 结论

- 判定：{{GO_OR_NO_GO_OR_INCONCLUSIVE}}
- 已确认事实：{{CONFIRMED_FACTS}}
- 推断及依据：{{INFERENCES_AND_BASIS}}
- 剩余未知项：{{REMAINING_UNKNOWNS}}

## 6. 交接

- 需要宿主决定的事项：{{HOST_DECISIONS}}
- 建议路由：{{SUGGESTED_ROUTING}}（继续实施 / 新 Spike / 更新 Spec / 创建 ADR）
- 已清理和保留的资源：{{RESOURCES}}

## 7. Spike 交付前检查

- [ ] 只回答一个有界决策问题
- [ ] 结论满足预先定义的判定门
- [ ] 事实与推断已区分
- [ ] 原始证据有稳定位置且文档只保留引用
- [ ] 敏感数据已移除
- [ ] 临时资源已清理
- [ ] 未越权修改 Spec、ADR 或产品实现
