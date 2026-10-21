# Agent Note: 分离的工具结果与前台转后台交接

Status: implemented

[English](2026-10-20-tool-call-auto-background.md) | 中文

## Problem

等待链其余部分的 `tools/execute` 包装层无法限制一个回合在单个工具上等待多久。调用要摆脱这种等待，随包提供的唯一方式是工具自己拥有后台任务——`bash` 会登记一个任务并在自身超时处转后台——因此其他所有长调用都会占住自己的步骤直到结束。通用包装层不能简单提前返回：注册表会按所属工具的输出声明校验包装层的成功结果，并在提交时冻结执行对象，仍在运行的调用体在恢复 `exec.signal` 时会抛错。

## Decision

`packages/guard/auto-background` 包装 `tools/execute`，在 `backgroundAfterMs`（`dsh-base` 中为 5,000 毫秒）之后把符合条件的调用移入 `tool` 任务。模型收到交接通知；调用最终输出追加到任务输出环，并通过 `job_output` 读取。

`ToolExecutionSuccess` 新增 `detached?: true`。它标记该包装层结果的 `content` 是交接通知而非工具输出，因此 `normalizeDispatchResult` 提交它时不按输出声明校验，且 `value: null`。该标记仅存在于进程内，从不持久化：重放时该通知就是一条普通成功结果。

- **资格。** 只有当调用是模型直接发起（没有 `exec.parent`，因为 `run_code` 子派发要把值交给等待中的程序）、属于某个会话（存在 `exec.agent`，因为该会话的任务控制器必须收取并停止工作）、且不在 `exclude` 中时才会被分离。默认排除名单为 `job_output`、`job_kill`、`job_list`、`ask_user_question`、`exit_plan_mode`：任务等待不能再生出任务，只在人作答后才结束的提示不能让问题在回合继续推进时留在界面上。
- **信号归属。** 委派之前，包装层装上自己的 `AbortController` 信号。注册表把它与调用方信号融合后交给调用体，包装层则保留该控制器作为任务的取消句柄，使 `job_kill` 能触达工具。
- **已冻结的执行。** 分离的调用体仍在运行时，执行对象就已提交并冻结。因此 `dispatchToolBody` 与包装层在执行冻结后跳过信号恢复，结算不会对已经没有读者的属性抛错。
- **尽力登记。** `ctx.jobs.start` 被拒（没有控制器、持有者任务数已达上限）时记录告警并改为前台等待该调用，而不是丢失它。

工具的协作式预算保持独立：[`tool-call-timeout-policy`](2026-07-07-tool-call-timeout-policy.zh.md) 继续执行声明的 `timeoutMs`，而被分离的调用仍受该截止时间约束，因为超时包装层的信号位于同一条派发链中。任务所用的注册表与交接语义由 [jobs seam 合并](2026-09-03-jobs-seam-consolidation.zh.md) 拥有。

## Consequences

- 分离调用的结果绕过 `tools/post-execute`、`projectContent`、`finalizeContent` 以及 spill 与裁剪策略，因为流水线已提交交接。其内容改由任务输出环的保留上限约束。
- 非文本内容块在环中只被点名而不被携带，因此图片结果在交接中失去其数据。
- 杀掉任务会中止派发信号；忽略取消的工具继续运行，而记录报告 `killed`。与其他所有工具调用路径一样，取消是协作式的。
- 自己拥有任务的工具可能嵌套：被移动的 `bash` 调用产生外层 `tool` 任务，其输出可能提到内层任务 id。
- 每个挂载该插件的组合都需要 `ctx.jobs` 与已挂上的控制器；缺少它们时插件保持不激活，而不是悄悄把一切都当前台执行。

## Testing

- `packages/guard/auto-background/tests/auto-background.spec.ts` 驱动真实的工具流水线、任务注册表与任务工具：窗口内直通、交接、错误结算、经任务杀停、`include`/`exclude` 范围、无持有者调用，以及插件 fiber 的释放。
- `packages/core/tools/tests/tools.spec.ts` 用输出声明拒绝 `value: null` 的工具固定分离直通行为，证明校验是被跳过而不是被放宽。
- `dsh-base` 中的配置行让交接在随包组合中运行。

## Alternatives considered

**返回错误结果而不是分离标记。** 流水线接受包装层撰写的失败结果且不做输出校验，因此这无需核心改动。但它把仍在运行的工作在对话记录和每个 UI 表面上标成失败，并诱使模型重试一个已在进行的调用。

**为每次调用登记任务，调用结算时再移除（`bash` 模式）。** 这保持流水线等待并避免提前返回。但它会为每个快调用消耗任务序号并产生可见记录抖动，而且包装层仍需要在调用结算前释放它。

**要求每个工具自己完成交接。** 这正是该插件要消除的限制：它迫使每个长运行工具接入任务 seam，并让第三方工具无法约束自己的回合。

**改为扩展 agent loop。** 工具流水线拥有单次调用的等待与取消；循环改动会重复任务 seam，并违反“新行为走文档化扩展点”的规则。
