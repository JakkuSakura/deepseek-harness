---
description: "在 goal 域记录自主完成声明之前对其进行核验的独立 LLM 评审器；供需要依据已记录证据检查完成声明的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-verifier-llm

[English](README.md) | 中文

## 概述

`dsh-goal-verifier-llm` 为 goal 域的完成核验扩展点提供 `ctx.goalVerifier` 实现。当模型声明某个自主 goal 轮次已完成时，本包会渲染会话中已记录的证据，让配置的模型依据目标评审这些证据，并且只有评审明确认定通过时才接受该声明。被拒绝时 goal 保持 active，评审给出的理由作为失败工具调用的消息返回给模型。直接由人类发起的完成不会被核验，因为人类轮次本身已经是该决定的授权来源。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当部署不能仅凭模型自己的说法认定 goal 已完成时，将本包与 `dsh-goal`、`dsh-tool-goal` 一起挂载。它是可选项：未挂载它的组合保持 goal 域已记录的行为，即记录完成的调用方具有权威性。

```yaml
- name: '@deepseek-ai/dsh-goal'
- name: '@deepseek-ai/dsh-tool-goal'
- name: '@deepseek-ai/dsh-goal-verifier-llm'
  config:
    provider: deepseek-official
    model: deepseek-chat
```

| 字段 | 必填 | 默认值 | 含义 |
|---|---|---|---|
| `provider` | 是 | — | 评审调用使用的已注册 provider 路由 |
| `model` | 是 | — | 评审调用使用的确切模型 id |
| `maxTokens` | 否 | `1024` | 单次评审批复的输出 token 上限 |
| `maxEvidenceChars` | 否 | `20000` | 发送给评审的证据字符上限 |

空的 `provider` 或 `model`，以及非正的 `maxTokens` 或 `maxEvidenceChars`，会在加载时失败，而不是留到第一次完成声明时才失败。

### 核验范围

只核验处于 goal 轮次授权下、`action: complete` 的 `update_goal` 调用，也就是模型自行认定工作的自主路径。另外三条完成路径保持不变：

- 顶层 agent 上的直接人类轮次会直接完成 goal，不咨询评审。
- `/goal`（`dsh-command-goal` 包）从不完成 goal。
- 进程内直接调用 `ctx.goals.complete()` 的调用方不受影响；goal 域仍将直接服务调用方视为可信生产者。

### 结果

| 评审批复 | 效果 |
|---|---|
| `VERDICT: COMPLETE` | 记录该声明；goal 变为 `complete` 并解除自动续跑 |
| `VERDICT: INCOMPLETE` | 拒绝该声明并附评审理由；goal 保持 active，当前轮次继续 |
| 无可用的判断结果 | 拒绝；无法解析的答复永不会认定完成 |
| Provider 错误、中止或截断 | 工具调用失败；goal 保持 active |

拒绝会以 `Goal completion was not certified: <reason>` 的形式抵达模型，因此模型可以在同一轮次内弥补差距，或让 goal 保持 active 进入下一轮。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节说明本包如何实现上述行为；可观察契约见 [Use this package](#use-this-package)。

### 设计

- **一次辅助请求，不改动 agent 上下文。** 评审通过 `ctx.llm.stream()` 运行，拥有自己的 system 指令和一条 user 消息。它从不进入 agent 的请求历史，不增加工具，也不产生自己的会话事件。
- **证据是日志的函数。** `renderGoalEvidence()` 遍历声明工具调用本就持有的不可变事件切片（与其授权检查捕获的是同一批 `events`），渲染出 `USER`、`ASSISTANT`、`CALL`、`RESULT` 和 `ERROR` 行。相同事件与相同 `maxEvidenceChars` 总是产生相同文本，因此评审请求可以由会话日志加配置重建。
- **双向有界。** 每条渲染项被裁剪到证据预算的四分之一；超出预算时最先丢弃最旧的项，并在开头标明；若单项仍然超出预算，则保留其最新的尾部。批复由 `maxTokens` 限制。
- **失败即拒绝。** 缺少 `VERDICT:` 行、无法识别的判断词、流错误或中止、以及 `max-tokens` 截断，都会拒绝核验。只有确切的 `COMPLETE` 一词才认定完成。
- **revision 精确。** 请求携带声明所引用的 `{ id, revision }` 以及授权检查解析出的 `GoalView`，因此评审与声明描述的是同一个修订。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LlmGoalVerifier` 服务（`ctx.goalVerifier`）、配置校验、评审调用、结束处理 |
| [`src/evidence.ts`](src/evidence.ts) | 有界且确定性的证据记录 |
| [`src/prompt.ts`](src/prompt.ts) | 评审指令、请求文本、严格判断解析器 |
| [`../../goal/goal/src/verification.ts`](../../goal/goal/src/verification.ts) | 本包实现的请求、判断结果与服务定义 |

### 组合要求

该服务注入 `llm`。评审模型属于部署配置，而不是 agent 当前路由的模型，因此会话切换模型时核验的成本与行为仍然可预期。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Goal group map](../README.zh.md) —— goal 服务、工具、命令与续跑驱动如何组合。
- [dsh-tool-goal](../tool-goal/README.zh.md) —— 咨询本核验器并返回其拒绝结果的工具。
- [dsh-goal](../goal/README.zh.md) —— 持久 goal 域及其完成授权规则。
- [Goal subsystem](../../../docs/subsystems/goal.zh.md) —— 与其他 goal 词汇并列的核验类型。

-----

<a id="model-experience"></a>
## 模型体验

### 完成核验请求

#### 模型看到什么

一条 agent 自身历史中从不包含的辅助请求：核验指令作为请求的 system 文本，以及一条携带目标、已接纳轮次计数与证据记录的 user 消息。被拒绝时，理由作为失败的 `update_goal` 结果返回给 agent，由工具层渲染。

##### 核验指令（原文）

```markdown
You are an independent verifier deciding whether an autonomous agent goal is complete.
Judge only from the goal objective and the recorded session evidence you are given. You did not do the work, and you cannot run commands or read files.

Rules:
- Answer COMPLETE only when the evidence establishes that every part of the objective is finished, with observed results rather than the agent's own claims.
- Answer INCOMPLETE when work remains, when the evidence contradicts the claim, when a result is missing, or when you cannot tell.
- Effort spent, a plan described, or a promise to continue are not evidence of completeness.

Reply with exactly two lines and nothing else. The first line is `VERDICT: COMPLETE` or `VERDICT: INCOMPLETE`.
The second line is `REASON: <one sentence>` explaining the decision.
```


#### Token 影响

每次自主完成声明增加一次模型请求。其输入受 `maxEvidenceChars`（默认 20000 字符）加上目标与固定指令限制；其输出受 `maxTokens` 限制。

#### KV Cache 影响

相互独立：该请求与对话不共享前缀，因此既不复用也不使 agent 自身请求的 provider 缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **同模型盲区** —— 评审也是模型，默认部署可能配置 agent 所用的同一模型；对证据的相同误读会同时通过两者。只有独立配置的模型与证据标准才能降低这种重叠。
- **仅限会话证据** —— 评审读取已记录的事件记录，而不是工作区。仅以当前文件内容存在、从未作为工具结果进入会话的证明无法被认定。
- **无持久判断记录** —— 判断结果只通过拒绝时的工具结果进入会话。被认定的完成不把评审自身输出写入日志；请求仍可由 goal 事件、证据切片和本包配置重建。
- **不核验阻塞** —— `update_goal action=blocked` 保留其轮次计数阈值；本包只核验完成声明。
- **未分类的辅助请求** —— 评审调用不设置 `GenerateOptions.purpose`，因此适配器将其视为普通请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

尚未决定的方向：用于让已认定判断在日志中可审计的持久 `goal/verification` 会话事件；用于让适配器按用途应用生成策略的 `purpose` 分类；面向需要机械而非模型判断的部署的确定性命令检查核验器；以及让评审检查工作区而不仅是日志的证据来源。

</details>
