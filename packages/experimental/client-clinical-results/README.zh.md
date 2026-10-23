---
description: "从聊天结果卡、右侧面板或独立 Web 页面读取经授权的已存临床报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-clinical-results

[English](README.md) | 中文

## 概述

此可选 Web 插件展示已接受的出院前核查报告、精确已存证据、覆盖缺口，以及独立的 DRG／DIP 可用状态。聊天结果卡打开其所在轮次接受的确切报告修订。既有右侧面板和 `?page=clinical-results` 页面复用一个展示组件；打开任一入口均不请求模型或采集证据。核查提示不阻断出院。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在受支持的 Web profile 中加载本包与[临床核查](../clinical-review/README.zh.md)。`allowedOrigins` 接受打开结果的 EMR 窗口的精确 HTTP(S) 来源。`requestTimeoutMs` 限制授权读取与请求受理的等待时间；`maxMessageBytes`、`maxPendingRequests` 和 `maxActionReceipts` 限制嵌入消息和保留回执。`directoryPageSize` 限制每页患者目录条数。公开配置不包含凭据或患者内容。

从聊天结果卡打开已存报告，或打开 `?page=clinical-results&sessionId=<reference>&resultId=<reference>&revision=<number>`。相对于工作区根文档解析此查询，并保留反向代理路径前缀。只包含 Session 的链接列出经授权的已存报告，并要求明确选择。引用不能授予访问权：每次读取均检查已认证所有者与就诊权限。报告始终保留来源引文及证据修订；不会将当前来源替换到历史引用中。

界面标注旧格式、缺失的历史元数据、未读取或不支持的覆盖范围、待人工复核，以及不可用的计算引擎。来源新鲜度只呈现明确接受的采集支持的比较，并显示时间和范围。新鲜度未知不影响阅读。零疑点不代表完整覆盖或医疗放行。

**请求重新核查**受理一次明确且幂等的请求。受理、分析进度和报告选择相互独立。新版可用后，更新进度并选择新的已存修订。读取失败时保留已展示报告并显示提示；认证或权限失效时清除临床内容。受理结果不确定时，应先检查进度和聊天再发起其他请求。

### 嵌入结果页

将附带 `?page=clinical-results` 的工作区根文档嵌入经授权的 EMR 父窗口或打开窗口，并配置其精确来源。每次加载公布新的协议版本化视图挑战。打开窗口必须校验工作区来源并保留窗口引用。协议仅传递选择引用及相关动作回执；报告正文通过已认证 HTTP 读取，绝不通过窗口消息传输。切换患者或账号时清除视图，并使未完成请求关联失效。直接打开的页面重连后重新授权同一明确报告修订。嵌入页面重连或重载后清除临床内容，并要求重新握手。

协议支持打开已存报告和请求核查。EMR 记录、字段和栏目导航在适配器提供经验证的映射及就诊检查前保持禁用。任意 URL、SQL、脚本或 DOM 选择器均不能执行。导航或核查请求完成不表示临床正文已保存或疑点已解决。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Host 入口验证公开配置，并注册已认证配置端点。浏览器入口注册独立页面，并可选地贡献轮次尾部结果卡及既有右侧面板标签类型。每个 `ResultController` 拥有有界请求、所选报告身份和可观察快照；不存在全局当前患者状态。共享 `ResultView` 展示有类型的已存结果响应，不解析 Markdown。卸载插件时移除路由、插槽、字典和监听器，中止请求并清除保留的视图内容。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [临床核查](../clinical-review/README.zh.md) — 已存结果投影、授权及明确请求核查。
- [EMR 就诊](../emr-encounter/README.zh.md) — 就诊身份与不可变证据。
- [结果展示需求](../../../docs/requirements/clinical-result-viewer-v1.zh.md) — 结果及动作验收场景。

<a id="model-experience"></a>
## 模型体验

用户明确请求重新核查时，通过临床核查间接影响模型。

#### KV 缓存影响

查看结果无影响。明确重新核查遵循临床核查的请求及证据行为。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 真实 EMR SSO、Cookie 策略、iframe 策略及反向代理来源需要在配置环境中进行浏览器验收。iframe 无法认证时，必须完成配置的顶层 SSO 流程后重新连接。
- 本包不配置 EMR 导航映射或计算引擎。旧疑点保留原分类，没有经验证的语义字段目标。
- 进度更新是明确读取，不是实时同步。新鲜度比较只覆盖完整已接受证据目录及其声明的覆盖范围。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

Host 与 Client 使用独立编译入口。浏览器集成通过受支持 Web profile 启动，只替换外部授权、证据、目录和模型提供方为合成资料；临床服务、已存结果 API、持久化和界面均使用真实实现。结果卡在报告持久化完成后读取确切已存修订进行确认；确认失败时不发布已存结果卡。

</details>
