---
description: "循环卫生 guard 家族的包映射：建议性重复工具提醒、单次工具调用超时策略，以及前台转后台的交接，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组针对三种失败模式保持 agent loop（智能体循环）高效。`repeat-tool-reminder` 在模型重复完全相同的工具调用时提醒它，让卡住的循环改变方法或结束任务。`timeout-policy` 执行工具声明的时限，让挂起的调用返回清晰错误，而不是拖住整个会话。`auto-background` 把超过前台窗口的调用移入后台任务，让慢调用把结果交回，而不是占住回合。三者都在 `dsh` 基础组合包中默认启用，可以调优或移除。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

三个小插件分别覆盖三种模式；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`auto-background/`](auto-background/README.zh.md) | 把超过前台窗口的调用移入后台任务，让回合继续推进 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看重复提醒的配置、策略背后的超时库决策，以及交接所登记的后台任务运行时。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——工具调用流水线、`detached` 结果，以及三个 guard 共同依赖的决策。
- [后台任务运行时](../../docs/subsystems/jobs.zh.md)——`auto-background` 把被移动的调用交予的任务注册表。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
