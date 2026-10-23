---
description: "把公司认证的 EMR 就诊绑定到私人 Session，读取已授权证据，并保存带精确引文的出院前核查建议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-clinical-review

[English](README.md) | 中文

## 概述

在私人会话中打开已授权的住院就诊，再发起不延迟出院的出院前核查。模型读取有长度限制的原文段落，并保存可核对引文的问题建议。刷新证据会使当前报告失效，同时保留历史。问题建议始终待医生核实；DRG 和 DIP 计算明确不可用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在公司认证的私人 Web 运行时中挂载本插件，并提供 Session 持久化、Session Controller、Connection 及既有模型配置。网关取数代理负责账号和就诊授权；浏览器传入的标识本身不授予读取权限。

### 配置

托管工作区部署提供代理地址、不透明的所有者身份和运行时凭据引用。数据库凭据留在代理中，模型凭据留在既有模型提供方中。运行时凭据通过 Credentials 或进程启动环境解析；插件配置不包含密钥。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `brokerBaseUrl` | 必填 | 代理 `launch`、`consume`、`authorize` 和 `capture` 请求的 HTTP(S) 基址 |
| `runtimeTokenEnv` | 必填 | 私人运行时令牌的凭据／环境变量名 |
| `ownerId` | 必填 | 网关提供的固定已认证所有者身份 |
| `cwd` | 必填 | 新建就诊 Session 的私人工作目录 |
| `agentPreset` | 标准默认预设 | 新建就诊 Session 可选的既有预设 |
| `readerMode` | `http` | `provided` 使用另外挂载的 `EncounterReader` 提供方 |
| `reviewLanguage` | `zh-CN` | 报告字段和最终回复所使用的语言 |
| `timeoutMs` | `30000` | 包括响应正文在内的完整代理请求超时 |
| `maxResponseBytes` | `8388608` | 完整代理响应上限 |
| `maxToolBytes` | `65536` | 完整模型可见文本块数组上限 |
| `maxSourceChars` | `12000` | 每段证据最多包含的 UTF-16 代码单元数 |
| `maxInventoryItems` | `20` | 每页资料清单的来源数 |
| `maxFindings` | `40` | 每份报告的问题数上限 |
| `maxOperations` | `256` | 每个就诊 Session 保留的事件标识数 |
| `maxReports` | `50` | 保留的历史报告数 |
| `maxRequestBytes` | `65536` | 完整浏览器请求上限 |
| `maxStateBytes` | `33554432` | 完整保留核查状态上限 |

[配置 schema](src/config.ts) 校验部署限制。要用 MCP 替换 HTTP 证据读取，可挂载 [EncounterReader](../emr-encounter/README.zh.md) 的实现，然后选择 `readerMode: provided`。浏览器启动授权仍使用代理。

### 接入、核查与刷新

[EMR 接入插件](../client-emr-entry/README.zh.md) 打开就诊并提供核查操作。`/api/clinical-review/` 下的已认证 POST 路由接收 JSON：`launch` 接收经校验的 EMR 启动声明；`review` 接收 `sessionId`、`eventId` 和 `trigger`（`manual-review` 或 `discharge-order`）；`refresh` 接收 `sessionId` 和 `eventId`；`status` 接收 `sessionId`。响应不缓存。以 `trigger: open` 打开时只绑定元数据，不读取临床正文，也不唤醒模型。

核查和刷新在持久化受理后返回 `sessionId`、`revision`、`status: accepted | duplicate` 和 `dischargeBlocked: false`。资料采集在后台异步继续。重复事件 ID 不会启动第二次核查。新的操作意图需要新的事件 ID。核查在已授权快照持久化后唤醒既有 DSH Agent；刷新只采集证据并使旧报告失效，不唤醒模型。状态接口只返回进度和当前报告是否存在；保存报告正文可通过已授权的结果 API 读取。

同一所有者／来源／医院／住院标识对应一个私人 Session。Session 不能切换患者。重新打开同一就诊时，如果已授权绑定发生变化，旧快照、已读范围和报告均失效。分叉会话保留历史文本，但不继承就诊读取权限。其他会话不会获得临床工具或核查指令。

### 保存结果

浏览器安全的 [`/result` 入口](src/result.ts)拥有带版本的请求与响应 schema。已认证的 `results` 按 `sessionId` 列出保存引用；`result` 按 `sessionId`、`resultId` 和确切的已接受报告 `revision` 读取。可选的 `encounterRef` 必须匹配当前绑定。结果包含原始 `reportId`、生成及证据时间、带保留来源元数据的精确引文、覆盖范围，以及分别不可用的 DRG／DIP 状态。列表允许为空；不存在的引用返回 `result-not-found`。读取通过代理的纯授权路由重新核验签名绑定和当前就诊策略，不采集证据，也不请求模型。精确就诊授权不查询来源；科室授权还会核验当前科室归属，无法核验时拒绝读取。后续明确刷新或核查采集会比较完整的已接受来源目录与覆盖范围，包括新增和删除；结果给出 `unchanged`、`changed` 或 `unknown`、检查时间及 `accepted-snapshot` 范围。此比较不对提供方覆盖之外的来源作出判断。

逻辑 `resultId` 在同一 Session 内稳定。修订按已接受的唯一报告计数，失败或取消的核查不产生报告修订。独立投影从完整保留的 Session 记录恢复各报告的原始快照。刷新后旧引文保持不变。缺失的保留元数据使用 null 或明确的不可用状态；旧格式疑点仅将已校验的原分类映射到三个注册问题编码（`inconsistency`、`missing-information`、`needs-verification`），不推断临床规则、语义字段或导航目标。生成时间取自原报告记录；仅存于历史数组的旧报告不推断生成时间。

`rerun` 接收确切的结果选择、必填的 `encounterRef` 和 `requestId`，然后确认异步核查受理。每次重试都重新核验当前授权。同 ID 同参数返回原受理修订，不重复执行；同 ID 改变所选修订或其他参数会被拒绝。当前核查进度独立于所选报告，核查失败保留此前已接受的报告。此 API 不导航或写回 EMR 记录。

### 失败与恢复

每次证据读取和报告提交都会重新校验授权，并比较已接受的来源版本。来源变化时拒绝过期操作。引文必须精确匹配此前已读的 UTF-16 范围；只有完整读取来源内容后，才能将其声明为已完整核查。不支持、未读取和空的来源类别保持区分。达到限制时拒绝完整请求、结果或保留状态，不做静默截断。

报告被拒绝时，诊断信息指出未完整阅读的来源，或发现项和引用的数组位置，不重复临床正文。可以完整读取来源，或将其从 `reviewedSourceRefs` 移除；对部分来源的引用仍必须精确匹配已读原文。未知来源引用仅用输入数组位置定位，不回显其内容。这些诊断沿用既有的已记录工具结果。

Session 刷盘结果不确定时停止后续核查操作，并报告 `durability: unknown`；继续前需核对持久化状态。恢复会话时，未完成操作标为 `failed`，并带 `errorCode: interrupted`，不会自动唤醒模型。检查会话后，用新的事件 ID 重试。核查轮次结束但未提交报告时，普通模型停止会使操作标为 `failed` 并带 `errorCode: report-not-submitted`，达到输出长度上限时则记录 `model-turn-max-tokens`；取消和模型错误也会记录明确结果。已读片段保留在历史中，不自动追加 followup。错误和取消不会写回 EMR，也不会改变出院完成状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[桥接入口](src/bridge.ts) 使用 Connection 的已认证 fetch 注册表。[读取器](src/reader.ts) 获取一次性启动授权，消费得到绑定，并按固定所有者核验有大小限制的证据响应。[协调器](src/state.ts) 串行执行每个 Session 的写入，在异步工作前持久化受理状态，并拒绝已被替代的结果。[状态投影](src/projection.ts) 重建活动核查状态；[结果投影](src/result-projection.ts) 在刷新和重启后保留不可变的报告与证据关联。[作用域工具](src/tools.ts) 只暴露对应 Agent 已接受的快照和建议；标准 Session Controller 和 Agent followup 机制负责模型执行。

卸载插件会中止取数，等待已受理任务结束，并移除路由和作用域工具。绑定、快照、已读范围、建议和事件结果保存在私人 Session 日志中。运行时令牌和数据库凭据不会写入日志。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [EMR 就诊](../emr-encounter/README.zh.md) — 共享的启动、身份和证据类型。
- [取数代理](../emr-reader-broker/README.zh.md) — 当前授权和数据提供方覆盖范围。
- [EMR 接入](../client-emr-entry/README.zh.md) — 手动接入和可信窗口嵌入。
- [托管工作区](../hosted-workspaces/README.zh.md) — 公司 SSO 和私人 Docker 运行时。
- [DRG 需求](../../../docs/requirements/drg-review-assistant-v1.zh.md) — 临床范围和分组前提。

-----

<a id="model-experience"></a>
## 模型体验

### 就诊核查

#### 模型看到的内容

已绑定 Agent 获得资料清单、原文阅读、问题提交和报告读取工具。显式核查会追加持久化用户消息，要求以 `reviewLanguage` 进行有证据依据的分析。来源元数据包含覆盖范围、截止时间、版本和来源引用；原文仅通过已记录的工具结果进入会话。报告将所有问题标为 `pending-human-review`，两种计算均标为 `unavailable`。

#### Token 影响

工具 schema 仅作用于已绑定 Session。资料清单分页、原文段落有长度限制，因此由模型选择哪些证据进入会话。每次成功读取和报告都会将精确工具输出加入 Session；重复核查保留旧会话上下文，并使用标准 DSH 压缩机制。

#### KV Cache 影响

绑定不会重写既有会话前缀。核查消息和工具结果追加到 Session；普通模型提供方的缓存复用取决于最终请求前缀。本插件不维护独立的模型记忆或缓存。

## 已知限制与待完成工作

<a id="known-limitations-and-deferred-work"></a>

本插件在当前提供方声明的覆盖范围内提供辅助核查。

- 不计算 DRG 分组、DIP 分值、医保支付、已确认编码或出院资格，也不写回 EMR。
- 当前每次临床工具调用都会重新采集完整已授权快照以确认时效。提供方可在保留版本和授权保证的前提下替换此实现。
- 中断或持久化不确定后不会自动重试，也不提供跨患者选择工具。保留上限需要运维人员评估容量。
- 已保存报告和原文保留在私人会话历史中；重新授权限制新的 API 与工具读取，不移除此前已显示的消息。保存结果读取不重新采集证据或启动新鲜度比较，也不提供已验证的 EMR 导航映射。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

包内组合测试通过标准 headless profile 启动，并使用合成外部证据和模型响应。[已记录 Session](../../../snapshots/session/pre-discharge-review/snapshot.yml) 无需患者资料或模型密钥，即可回放真实证据工具和带引文的建议。公司 SSO、网关授权和数据库连通性需要部署联调验证。

</details>
