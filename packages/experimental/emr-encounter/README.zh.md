---
description: "通过可替换提供方读取已授权就诊证据，明确来源版本与覆盖情况。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-emr-encounter

[English](README.md) | 中文

## 概述

读取一次已授权就诊的不可变原始证据，保留来源标识、内容摘要及明确覆盖情况。替换提供方无需修改核查工具。消费方将绑定限制在所属账号及 Session；解析标识不代表获得患者权限。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

挂载一个具体读取提供方，例如[受控 PostgreSQL 读取器](../emr-reader-broker/README.zh.md)，消费 `ctx.encounterReader`。抽象服务没有独立挂载配置。运行实例消费方通过导出的解析器校验网络响应后再保存证据。浏览器消费方从 `@deepseek-ai/dsh-experimental-emr-encounter/wire` 导入相同解析器，无需加载 Cordis 服务。

绑定保留已验证账号、签发方、主体、医院及就诊标识。来源保留原文与源状态；覆盖情况区分完整、空、未读及不支持类别。空表示受支持查询没有返回记录，不代表不存在疾病或治疗。

提供方在每次捕获时重新授权、响应取消，并明确拒绝不完整或超限快照。消费方负责 Session 绑定、持久证据、引用及过时结果处理；提供方响应本身不改变 Session 或唤醒智能体。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[服务定义](src/index.ts)将带授权的捕获操作与传输、数据库实现分离。[网络校验](src/schema.ts)拒绝额外启动字段、非法标识编码、重复来源引用及不完整类别覆盖。[记录类型](src/types.ts)区分不透明标识和来源系统住院编号。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [临床插件设计](../../../docs/requirements/drg-review-assistant-v1-plugins.zh.md) — 核查所有权及提供方替换。
- [读取代理](../emr-reader-broker/README.zh.md) — 受控开发 PostgreSQL 取数。
- [架构](../../../docs/architecture.zh.md) — 提供方与消费方组合。

<a id="model-experience"></a>
## 模型体验

无，因为此服务定义不注册模型工具、提示词或 Session 内容。

#### KV 缓存影响

没有直接影响；核查消费方负责模型可见证据及其记录。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此实验交换格式不提供生产患者权限策略或临床分组引擎。
- 此处没有实现 MCP 传输。后续提供方须保留授权、版本、原始内容及覆盖语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
