---
description: "面向用户与维护者的具备回放感知的 token 与上下文压力计量说明：评估提示词规模或构建压缩（compaction）与占用显示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-token-meter

[English](README.md) | 中文

## 概述

使用 `ctx.tokenMeter` 估算会话的请求与上下文压力，或为单条消息计价。测量会回放持久会话日志，结果确定且不进行模型调用，因此压缩、占用显示与遥测共享同一结果。会话投影提供 `tokenUsage`、`contextPressure` 与 `contextBreakdown`；文本和没有图片定价的路由采用固定启发式规则，存在声明时应用视觉 token 定价，文件则按模型可见的句柄文本计价。只有请求 envelope 完全相同时才复用提供方报告的用量；本包不在 loop 中做决策，并在挂载提示词注册表时把当前占用作为运行时上下文渲染给模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当消费方需要为压缩决策、占用显示或遥测获取 token 或上下文压力时挂载本插件。估算器没有任何配置；模型容量属于拥有精确提供方／模型路由的适配器，可通过 `ctx.llm.resolveModelInfo().context` 获取。同时挂载提示词注册表时，插件会把当前占用作为运行时上下文渲染给模型（见[面向模型的上下文用量](#model-facing-context-usage)）。

### 何时选择

当多个插件应该就同一种基于回放的测量达成一致时选择它——压缩规划、占用 UI 与压力检查都读取同一个 fold。测量回放持久会话日志，因此确定、无需模型调用，并精确反映已记录内容。文本和未声明图片定价的路由使用固定启发式规则；当部署需要精确到计费级别的计数时，使用提供方分词器。

### 测量压力

`ctx.tokenMeter` 暴露两个操作。`measure(session, requestHeader?)` 在同一个已消费日志 revision 上返回独立、深度不可变的快照：`totalTokens` 是请求与响应压力，`surfaceTokens` 是仅表面的路由定价总量，等于 `nodes[].tokens` 之和。可选 `requestHeader` 覆盖会选择计价路由与压力字段；节点集合仍描述当前会话。`estimateMessage(message)` 用固定启发式规则为一条消息计价。每次调用都会克隆带位置的表面节点，因此测量是 O(surface)。

```text
const { totalTokens, surfaceTokens, nodes } = ctx.tokenMeter.measure(session)
const price = ctx.tokenMeter.estimateMessage(message)
```

每次测量都会通过可选的 `llm` 服务解析生效 envelope 的提供方／模型。适配器声明图片定价时，图片出现处使用路由请求的视觉 token 价格加模型可见文本，`image/offload` 事件选中的出现位置则按路由的占位文本计价，与表层实际发送的一致；其他路由保持固定启发式规则。文件出现处使用同一个 `llm` 服务为适配器分发解析的确切、与路由无关的 句柄文本，其中包含当前执行世界路径或明确的无路径说明。每个节点还携带与路由无关的 `heuristicTokens`，供替换影子价使用。只有当最新成功调用的规范请求 envelope 与已测量 envelope 匹配、且其总量不低于该调用完整路由定价锚点时，才复用提供方用量；否则会对完整当前 envelope 与表面做估算。表面变更保持相对于按同一路由重新定价的匹配锚点的带符号值，包括缩减替换后的负 delta。

测量锚点包含成功的 `assistant/message` 之前的已计价表面，包括 `step/start` 之后接纳的系统与用户消息，以及重试之前执行的替换。持久输出未变时，完成调用的表面增量为零：其提示词已包含在提供方用量中。后续表面变更仍是相对于该锚点的带符号增量。

### 会话投影

当组合提供 `ctx.sessionProjections` 时，token-meter 注册三个投影单元。`tokenUsage` 携带完整持久日志中的 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens` 与 `cacheWriteTokens`。最终 assistant 消息样本会替换同一次尝试的流式用量；`llm/retry-started` 会结束该替换范围，因此同一步骤中的重试会贡献另一次计费用量。`contextPressure` 携带可选 `pressureTokens`（提供方报告的最新提示词规模）、可选 `projectedTokens`（下一个请求的提示词将花费多少）与来自最新一条 `request/context` 记录的可选 `contextWindow`。`contextBreakdown` 携带启发式 `systemTokens`、`toolsTokens` 与 `messageTokens`——上下文的构成，而非提供方计费规模。卸载插件会移除全部三个键。

图片省略重新计算现有节点的价格，同时保留此前的用量锚点。固定引用启发式规则不计入 `offloaded` 元数据，因此一次省略决定不改变 `contextBreakdown` 或标量启发式总量，按路由的测量则把所选图片的视觉价格换成占位文本价格。

`contextBreakdown` 把 surface 顺序中最后一个非空且存活的 `system/message` 归入 `systemTokens`；休眠的空节点不贡献 token，没有非空系统消息时为零。`messageTokens` 包含其余所有可见节点，包括被取代的提示词。在追加、已计量的压缩与裁剪、系统提示词改写或清空之后，两者之和等于 `measure().nodes[].heuristicTokens`；对非系统范围的未计量替换以零增量折叠，与 `contextPressure` 相同。`toolsTokens` 跟随最新 `request/header`。三个数字都使用固定启发式规则，而非路由图片定价或文件句柄投影；它们是近似构成，不是计费数据或 `projectedTokens`。

`deriveTurnTokenUsage(events)` 为浏览器消费方把一个完整轮次折叠为精确的逐次尝试与整轮用量。生命周期证据缺失、计数不安全或精确总量矛盾时不返回结果；只有每次参与的尝试都报告可选缓存、推理或路由值时，相应汇总才会出现。

<a id="model-facing-context-usage"></a>
### 面向模型的上下文用量

挂载 `ctx.systemPrompt` 时，meter 贡献一个运行时上下文小节 `token:usage`，排在 sandbox 与审批策略之前。它渲染这样的句子：`Context usage: about 250,000 of the 1,000,000-token context window is in use (25%, about 750,000 tokens free).` 分子是 `contextPressure` 投影的 `projectedTokens`（缺失时回退到 `pressureTokens`），因此模型与会话状态显示读取同一个数字；分母是该投影的 `contextWindow`。两者都具备之前，该小节不渲染任何内容；无 agent 的装配也不贡献任何内容。

上报值按窗口的 5% 取整，任何非零用量至少上报一档，因此会话只在占用跨档时追加新的运行时上下文快照。

### 组合

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-basic'
```

两个插件都有可用默认值。meter 只消费可选的 `llm` 服务，且仅用于解析路由声明的请求图片定价；压缩保持可选。部署会在 LLM（大语言模型）适配器上配置容量与图片定价，并在 `dsh-compaction-basic` 上配置压缩策略。

### 解读数字

占用是参考数字，不是计费记录：压缩读取 `measure()`，而面向模型的句子报告的是 `contextPressure` 投影。UI 用测量压力除以所选模型独立解析的容量来计算占用。`contextBreakdown` 数字是估算值，其总和不会等于 `projectedTokens`；后者的提供方锚点恰好携带启发式误差——CJK 文本与 JSON schema 在每 token 四字符下严重低估。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

服务建立在一个 fold 与一个锚点之上。每个会话都有隔离的回放状态——已消费事件游标、规范请求标头、已计价表面、步骤边界与测量锚点——通过折叠持久日志推进。只有当提供方用量的规范 envelope 匹配、且其总量不低于同一次调用的完整路由定价时，才用它锚定测量；否则会估算完整 envelope 与表面。与路由无关的 `heuristicTokens` 字段使替换影子价投影保持确定性。fold 是整体且分配全新的：格式错误事件会在任何变更前抛出，因此同一份日志每次重试都以相同方式失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `TokenMeter` 服务：回放状态、fold、`measure()` 与 `estimateMessage()` |
| [`src/estimate.ts`](src/estimate.ts) | 固定启发式规则：每 token 四字符加块与角色开销 |
| [`src/surface-fold.ts`](src/surface-fold.ts) | 与 `measure()` 共享的位置表面 fold |
| [`src/surface-projection.ts`](src/surface-projection.ts) | O(1) 投影单元的影价协议 |
| [`src/usage-projection.ts`](src/usage-projection.ts) | `tokenUsage` 与 `contextPressure` 投影定义 |
| [`src/prompt-context.ts`](src/prompt-context.ts) | 面向模型的占用句子及其上报档位 |
| [`src/breakdown-projection.ts`](src/breakdown-projection.ts) | `contextBreakdown` 投影定义 |
| [`src/client.ts`](src/client.ts) | 面向投影消费方、可安全用于浏览器的客户端接口 |
| [`src/turn-usage.ts`](src/turn-usage.ts) | 精确逐次尝试与逐 Turn 用量的纯 fold |

### Fold 流程

每次 `measure()` 调用都把 fold 同步到当前持久尾部，然后读取一份连贯快照。fold 跟踪完整请求标头快照、步骤边界、表面追加与替换、成功 assistant 消息及提供方用量。用量锚点的提供方输出从 assistant 消息的精确内嵌流重新组装，与监听器对持久内容的改写相互独立；空的重组内容计价为零。

### 投影语义

`contextBreakdown` 只保留存活的 `system/message` 节点及其启发式价格、一个 surface 运行总量，以及至多一个已武装的影子价 claim；替换减去紧邻的 claim（其 `shadowedSeqs` 同时列出被移除的系统提示词），或减去被改写的那个系统提示词的保留价格（[决策](../../../.agents/notes/implemented/architecture/2026-10-13-context-breakdown-system-prompt-state.zh.md)）。其状态取决于存活系统提示词的数量，而非消息数；状态版本 6 使位置检查点失效。`contextPressure` 是另一个标量影子价消费方：没有相邻 claim 的替换贡献零增量。用量 fold 保留一个最后样本槽，因为合法日志不会在更晚步骤报告用量后再次报告更早步骤的用量。

`./estimate` 导出无服务状态的文字与内容估算函数，供工具结果保留复用。图片的实际请求成本由模型适配器的 `imageRequestPricing` 提供。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从计量服务逐步进入压缩消费方与共享类型。

- [Token 计量子系统](../../../docs/subsystems/token-meter.zh.md)——`ctx.tokenMeter` 背后的测量语义。
- [dsh-llm 服务](../llm/README.zh.md)——其容量元数据由 `resolveModelInfo()` 提供的模型调用服务。
- [压缩能力](../../../docs/subsystems/compaction.zh.md)——读取 `measure()` 的压力敏感消费方。
- [投影 token 用量](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)——`projectedTokens` 背后的设计与被否决的原子配对比较。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——本服务计价的消息与块类型。

-----

<a id="model-experience"></a>
## 模型体验

### 运行时上下文占用

#### 模型看到的内容

挂载 `ctx.systemPrompt` 时，插件贡献一个运行时上下文小节 `token:usage`，排在 sandbox 与审批策略之前。循环只在该快照文本变化时才把当前运行时上下文快照落成持久 user 消息，因此模型看到最新的占用句子，此前的快照被取代。该句子报告 `contextPressure` 投影的预计提示词规模对比最新声明的窗口，并按窗口的 5% 分档取整。meter 不发起模型调用，也不添加工具或 schema。

#### Token 影响

每次变更的快照是一条运行时上下文 user 消息：占用句子加上其他生效的运行时上下文小节，通常不超过 120 tokens。5% 上报档位决定一个窗口最多产生 20 次快照，而压缩通常会在窗口填满前降低占用。

#### KV Cache 影响

快照仅追加：每次变更的快照在保留历史之后追加一条 user 消息，因此其之前的前缀仍可复用；未变更的快照不追加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明计量在哪里停止、由未来工作接续。它们是当前包约束，不是通用 token 计量对比或任务积压。

- **固定启发式规则是近似值**——没有可复用提供方用量的文本按字符数加结构开销计价，而非精确提供方分词器或请求序列化器；只有声明了定价的路由上的图片出现处携带提供方精确的视觉 token。
- **每次测量都克隆当前表面**——连贯不可变快照让读取为 O(surface)，包括低于阈值的压力检查。
- **提供方用量只在规范 envelope 完全相同时可复用**——工具、提供方、模型或调用配置变化会刻意回退到完整启发式估算；系统提示词变更在下一次成功调用之前按带符号的表面增量计量。
- **系统提示词改写不带影子价**——循环替换 system 节点时没有紧邻的计量事件，因此 `contextPressure.projectedTokens` 以零增量折叠该替换，直到下一个用量样本；`contextBreakdown.systemTokens` 与 `measure()` 会立即按新提示词重新计价。
- **构成检查点保留当前 surface**——精确的 system/message 分类需要位置条目；检查点大小和 surface 事件折叠成本为 O(当前保留 surface)。
- **面向模型的句子是粗粒度参考值**——按 5% 分档取整，切换模型后会滞后一次请求，也不决定压缩何时运行（压缩读取 `measure()`）。它报告的是窗口占用，不是任务预算。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 固定每 token 四字符启发式规则会低估 CJK 文本与 JSON schema；复用用量时提供方锚点恰好携带该误差，请把构成行呈现为近似构成，绝不呈现为总量。
- 按提供方的精确分词器尚未决定；保持单一确定性启发式规则，正是让每个消费方的测量一致且回放稳定的原因。

</details>

用量 fold 在每次尝试内替换样本，总量不必单调。构成和测量共享位置替换规划器与固定估算器，因此启发式 surface 总量按构造一致。路由定价总量有意与之不同。
