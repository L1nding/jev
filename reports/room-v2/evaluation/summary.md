# 房间求解 v2：统一配置实测

房间数：6；模型接受：0。

| 房间 | Seed | 结果 | 原因 | 候选面积㎡ | Jev请求 |
|---|---|---|---|---|---|
| 资料室 | source:3DFB04 | incomplete | context_budget_exhausted_with_defects | — | 20 |
| 登记室 | source:3DFB06 | uncertain | jev_rejected_all | 0.135 | 22 |
| 冷链室 | source:3DFB32 | incomplete | context_budget_exhausted_with_defects | — | 26 |
| 哺乳室 | source:3E0194 | incomplete | context_budget_exhausted_with_defects | 3.477 | 18 |
| 接种室 | source:3E01A3 | incomplete | context_budget_exhausted_with_defects | — | 19 |
| 留观区 | source:3E01BE | uncertain | jev_rejected_all | 455.683 | 23 |

全部使用相同 DXF 展开几何、源语义、算法代码和预算。详细原始请求及响应保存在各房间 JSON 中。

- 同一图纸开发性评测，不是跨图纸泛化验证
- 没有独立人工真值；accepted 也不等于确认正确
- 旧报告预处理不同，不将历史数字当作公平准确率对比

这些结果衡量当前端到端求解的实际完成情况，不将拒绝错误候选包装为识别成功。
