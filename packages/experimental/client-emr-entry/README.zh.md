---
description: "在 Web 工作区嵌入经过认证的就诊入口与可选的出院前核查。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-emr-entry

[English](README.md) | 中文

## 概述

这个可选 Web 插件可以从 EMR 窗口或仅含标识的表单打开私有就诊 Session。用户通过现有会话标题栏发起出院前核查和证据刷新。临床证据与核查结果保留在 Session 中，核查始终不阻断出院。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在 Web profile 中将本包与 [clinical-review](../clinical-review/README.zh.md) 一起启用。Host 导出通过仅允许 owner 的 Connection 路由提供公开配置；Client 导出注册侧栏入口、会话标题栏核查按钮及共享弹窗与提示。应用通过 `dsh` Web profile 和部署 overlay 启动。

```yaml
- name: '@deepseek-ai/dsh-experimental-client-emr-entry'
  config:
    allowedOrigins: ['https://emr.example']
    defaultSourceSystem: emr
    defaultHospitalCode: test-hospital
    requestTimeoutMs: 30000
    maxPendingRequests: 4
    maxMessageBytes: 8192
```

`allowedOrigins` 默认为空列表，此时不接收窗口消息，但表单仍可使用。每项必须是精确的 HTTP(S) origin，不能带凭据、路径或末尾斜杠。两个默认值是必填表单配置，不授予就诊访问权限。`requestTimeoutMs` 限制操作等待时间，`maxPendingRequests` 限制并发请求，`maxMessageBytes` 限制每条消息大小。取数 broker 仍独立校验账号、医院和就诊权限。

### 打开与核查就诊

点击侧栏的“接入就诊”，填写来源系统、医院编码、住院记录 ID 及可选住院流水号。打开 Session 只绑定标识，不读取病历正文，也不调用模型。在对应 Session 点击“出院前核查 → 开始核查”才会采集证据并开始分析。“刷新证据”采集新快照，但不发起分析；需再次核查来替换旧结果。结果通过现有聊天工具呈现。在配置计算提供者之前，DRG／DIP 预分组保持不可用。

打开核查弹窗会读取当前 Session 的进度和核查版本。“更新状态”只重新查询元数据，不采集证据，也不调用模型。弹窗区分报告已生成且待人工确认、模型结束但未提交报告、输出长度超限、状态读取失败和访问被拒绝。普通聊天会明确提示尚未接入就诊。状态查询失败时保留上次读取的元数据并标明其时效。关闭弹窗、切换 Session 或卸载插件后，旧响应不会覆盖当前视图。

操作失败或结果不确定时，表单保留并显示共享提示。对于结果不确定的请求，重试前先查看 Session。本地取消只停止等待，不撤销服务端已经接受的操作，也不影响出院。

### 嵌入 EMR 入口

[静态浏览器示例](examples/emr-entry.html) 可以由现有 EMR 开发服务器提供。将该服务器的精确 origin 加入 `allowedOrigins`。先登录工作区，再把个人工作区 URL 填入示例。嵌入页面必须保留弹窗或 iframe 的窗口引用，这种集成不能使用 `noopener`。

工作区仅向配置 origin 上的 opener 或 parent 发送 `{ type: 'dsh.emr.ready' }`。EMR 校验 `event.source` 和预期个人工作区 origin 后，向该精确 origin 发送 `{ type: 'dsh.emr.launch', value: claim }`。claim 包含 `eventId`、`trigger`、`sourceSystem`、`hospitalCode`、`inpatId`，以及可选的 `inpatCode`、`sourceVisitId`、`documentId`、`documentRevision`。切换患者时使用 `trigger: 'open'`；`manual-review` 与 `discharge-order` 明确申请核查。不接受临床正文。

回执包含 `type: 'dsh.emr.launch.result'`、原始 `eventId`、`dischargeBlocked: false`，以及 `status: 'failed'`，或成功的 `status` 与 `sessionId`。回执不包含患者详情或报告。内容相同的重复 event ID 在等待期间复用一次请求，服务端负责持久事件去重。新的操作需使用新的 event ID。示例限制握手等待时间，不会以回执作为出院前提。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 管理公开配置及认证路由。[`src/client/index.ts`](src/client/index.ts) 管理语言、插槽注册和受信窗口消息。[`actions.ts`](src/client/actions.ts) 管理有界的浏览器同源请求、取消及 `uiWorkspace.openSession` 导航，只有最后发起的操作可以切换当前 Session。[`protocol.ts`](src/client/protocol.ts) 校验窗口消息和元数据响应。[`Entry.tsx`](src/client/Entry.tsx) 复用共享弹窗、输入框、按钮和提示。卸载插件会移除监听与注册、取消浏览器待完成请求，并等待它们结束。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [临床核查](../clinical-review/README.zh.md) — Session 绑定、证据采集、核查提交及报告有效期。
- [EMR 就诊](../emr-encounter/README.zh.md) — 标识与证据类型。
- [托管工作区](../hosted-workspaces/README.zh.md) — 公司 SSO 与私有运行时隔离。

<a id="model-experience"></a>
## 模型体验

通过 clinical-review 间接影响模型，由后者将显式核查操作转为已记录证据与核查请求；打开就诊和刷新证据均不调用模型。

#### KV Cache 影响

无直接影响；后续请求内容与缓存复用由 clinical-review 的 Session 事件决定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 窗口集成需要已登录的个人工作区，并保留 opener 或 parent。首次登录重定向若改变工作区 origin 或移除 opener，需要登录后重新握手；本包不把就诊上下文保存在 URL fragment 或浏览器持久存储中。手动入口表单始终可用。
- 普通聊天也可能显示核查按钮，开始核查前需先接入就诊。
- 仅在打开弹窗或点击“更新状态”时读取进度，不自动轮询。报告正文仍保留在聊天中，本包不配置 DRG／DIP 计算引擎。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

Host 与 Client 使用独立叶子配置编译。包内测试通过 Loader 配置验证认证路由、受信窗口消息、请求取消及本地化表单输出，不使用患者资料或模型密钥。

</details>
