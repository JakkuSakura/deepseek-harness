---
description: "工具调用的前台时限：把超过窗口的调用移入后台任务并返回交接结果，供用户选择、调参或排查该守护插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-call-auto-background

[English](README.md) | 中文

## 概述

用这个包避免一次工具调用无限期占用一个回合。超过窗口（`backgroundAfterMs`，默认 5,000 毫秒）的调用会移入后台任务：模型收到点名该任务的交接结果，调用最终输出像其他后台工作一样经 `job_output` 取回。插件只有一个 `tools/execute` 包装器，无需改动任何工具，并在 `dsh` 基础包中默认启用。

## 目录

- [使用这个包](#use-this-package)
  - [何时选用](#when-to-choose-it)
  - [配置方式](#setting-it-up)
  - [得到什么](#what-you-get)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把插件加入组合后，慢调用不再阻塞其回合；`dsh` 基础包已以 5,000 毫秒启用它。

### When to choose it

当回合必须在工具工作期间继续推进——长时间构建、子代理委派、缓慢抓取——且晚一个任务往返拿到结果可以接受时，选用它。如果某个工具的答案决定紧接着的下一步且无法推迟，或该工具只在人作答后才结束，则不要用它；默认 `exclude` 已把随包提供的人机交互工具排除在外。

### Setting it up

```yaml
- id: tool-call-auto-background
  name: '@deepseek-ai/dsh-tool-call-auto-background'
  config:
    backgroundAfterMs: 5000
    include: []
    exclude:
      - job_output
      - job_kill
      - job_list
      - ask_user_question
      - exit_plan_mode
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backgroundAfterMs` | `5000` | 调用可运行多少毫秒后回合停止等待。必须是正有限数。 |
| `include` | `[]` | 允许交接的工具名；为空表示所有工具。 |
| `exclude` | 上面五个名字 | 永不移动的工具名，在 `include` 之后检查。 |

组合还必须提供 `ctx.jobs`（例如 `@deepseek-ai/dsh-jobs-local` 这样的任务注册表）以及 `@deepseek-ai/dsh-tool-jobs` 挂上的控制器。缺少它们时插件保持不激活，而不是悄悄把每次调用都当前台执行。

### What you get

在窗口内结束的调用原样返回自己的结果，且不登记任务。超出窗口的调用返回 `[still running after <ms>ms; moved to background job <id>]` 及任务交接指引，并作为调用会话拥有的任务继续运行：它出现在 `job_list` 中，最终输出用 `job_output` 读取，`job_kill` 可停止它。杀掉任务会通过调用体被派发时所用的信号中止调用，因此遵守取消的工具会停止；任务以 `killed` 结束并带上杀停原因。取消调用本身同样会杀掉任务。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

包装器拥有前台时限、任务登记和交接文本；它不拥有终止：被移动的调用只在任务被杀或持有者被拆除时停止。

**谁符合条件。** 当调用是模型直接发起（没有 `exec.parent`，因此 `run_code` 子派发永不被分离）、属于某个会话（存在 `exec.agent`，因为该会话的任务控制器负责收取并停止工作）并通过 `include`/`exclude` 时，才会被移动。

**信号替换。** 委派之前，包装器把自己的 `AbortController` 信号装到 `exec.signal` 上；注册表在 `next()` 内同步读取该属性，并与调用方信号融合后交给调用体。包装器保留该控制器作为任务的取消句柄，使 `job_kill` 能触达工具，并在调用体结束之后恢复调用方信号。

**竞速。** `next()` 立即开始，包装器让它与定时器竞速。调用先结束则原样返回其结果。定时器先到则由 `ctx.jobs.start` 登记一个 `tool` 任务，其生产者接管仍在进行的派发；登记被拒（没有控制器、持有者任务数已达上限）会记录一条告警并回退为前台等待调用，因此被移动的调用不会丢失。

**分离结果。** 包装器返回标记为 `detached` 的成功结果，于是注册表提交交接内容而不按工具的输出声明校验它——此时尚无规范值。调用体结束后，任务把工具渲染好的内容追加到输出环并结算；抛错或错误结果以 `failed` 结算并带上消息，取消则以 `killed` 结算。

**为什么执行对象保持可写。** 流水线在提交交接时冻结执行对象，而分离的调用体仍在运行。调用体自身的信号恢复与包装器的恢复都会跳过已冻结的执行，因此结算不会对已经没有读者的属性抛错。

### Source map

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`/`inject`/`Config`/`apply`、`tools/execute` 包装器、任务登记与交接文本 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [工具子系统参考](../../../docs/subsystems/tools.zh.md) —— `tools/execute` 瀑布、`detached` 结果与取消语义。
- [后台任务运行时](../../../docs/subsystems/jobs.zh.md) —— `ctx.jobs` 契约、归属与输出环。
- [jobs 包组](../../jobs/README.zh.md) —— 注册表、本地实现与面向模型的任务工具。
- [guard 包组地图](../README.zh.md) —— 相邻的循环卫生守护插件。

-----

<a id="model-experience"></a>
## 模型体验

### Conditional tool result

#### What the model sees

在窗口内结束的调用对模型不可见：模型读到工具自己的结果。超出窗口的调用被替换为 `[still running after <ms>ms; moved to background job <id>]`，后接一句话，说明调用仍在后台运行、会有完成通知、`job_output` 读取它而 `job_kill` 停止它。确切文本固定在 [`src/index.ts`](src/index.ts) 中。不新增提示词段落或工具模式。

#### Token effect

调用在窗口内结束时零额外 token。一次交接花费一个很小的结果，加上模型读取时工具最终输出所占的 token——这些本来也会以前台形式付费。

#### KV Cache effect

仅追加：交接结果是可复用请求前缀之后的一条新工具结果，后续 `job_output` 内容同样追加，因此已有 KV 缓存条目保持有效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制是当前包的约束，不是任务清单。

- **仅协作式取消。** 杀掉被移动的任务会中止其信号；忽略取消的工具会继续运行，而任务记录报告 `killed`。同进程代码无法被硬停。
- **分离结果绕过结果策略。** 由于流水线已提交交接，最终输出不再经过 `tools/post-execute`、`projectContent`、`finalizeContent`，也不经过 spill 与裁剪策略；它改为追加到任务输出环，受该环保留上限约束。
- **非文本块只被点名，不被携带。** 文本结果原样进入任务；图片或文件块变为 `[<type> content is not carried into a background job]`。
- **自管理工具会嵌套。** `bash` 等 shell 工具在前台调用等待期间本就登记自己的任务，因此被移动的 shell 调用会产生一个外层 `tool` 任务，其输出可能提到内层任务 id。它们自身的超时转后台仍在内层生效。
- **只有会话拥有的模型直接调用被移动。** 无持有者的调用、`run_code` 子派发、以及没有挂上任务控制器时的调用都保持前台行为。
- **登记被拒时回退。** 任务注册表拒绝启动（没有控制器、持有者任务数已达上限）时，调用继续在前台等待并记录告警；交接是尽力而为，绝不丢失数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

- 默认排除名单是安全边界：防止任务等待（`job_output`）再生成任务，也防止人机交互提示（`ask_user_question`、`exit_plan_mode`）在回合继续推进时把问题留在界面上。扩充它是产品决定，不是调参。
- `ToolExecutionSuccess` 上的 `detached` 标记就是为这次交接而存在；返回它的包装器对该调用的最终结果负责，流水线则不再观察它。
- 基础包中的 5,000 毫秒窗口是否应适用于所有工具，仍待产品证据；`include` 可按部署收窄范围而无需改代码。

</details>
