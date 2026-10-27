---
description: "通过三个受限只读工具分析路径定义和历史人群，并明确依据覆盖范围。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-clinical-pathway-reader

[English](README.md) | 中文

## 概述

使用获准的路径定义、历史人群和就诊依据，分析指定路径或准备新建、修订的参考方案。查询保留来源标识、筛选和覆盖限制。三个读取工具仅提供给临床路径 preset，数据库凭据留在网关。不创建医院草案、业务版本或临床写入。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将插件分别作为认证网关提供方及可选 `clinical-pathway-analysis` preset 中的工具挂载。它不是 bundle 或可执行程序。[托管覆盖](../../../deploy/hosted-workspaces/compose.clinical-pathway.yml)选择专用运行时组合；普通路径与医保核查组合保留原有行为。

```yaml
- name: '@deepseek-ai/dsh-experimental-clinical-pathway-reader'
  config:
    mode: gateway
    sourceSystem: emr-pg-develop
    databaseConfigFile: /run/secrets/pathway-database.json
    policyFile: /run/secrets/pathway-policy.json
    schema: public
```

数据库文件接受 `host`、`port`、`database`、`user`、`password` 及可选布尔值 `ssl`。文件放在模型不可读位置，仅挂载给网关。提供方在启动及每次读取时核对实际 schema、必要列、SELECT 权限和强制只读事务。`readRolePolicy: select-only` 还会拒绝可写角色或源表所有者；经明确确认的开发联调可选 `development-transaction-only` 复用已有普通角色，固定 SQL 和经校验的 READ ONLY 事务仍拒绝写入。两种模式都不修改 schema 或角色。

策略独立于仅限在院患者的授权。`schemaVersion: 1` 对象包含 `grants`；每条需 `issuer`、`subject`、`sourceSystem`、`hospitalCode`、`departmentCodes`、`departmentBasis`（`current` 或 `discharge`），以及带时区 ISO 时间 `admissionFrom`、`admissionTo`。`includeSharedDefinitions` 缺省 false；true 允许同医院共享科室 `-1`，不授予标准医院。每个账号／来源／医院只设一条授权；仅有唯一匹配时才可省略医院选择。空授权拒绝访问，结果放行前重新读取策略。

在 preset 内，`mode: tools` 需要以 `/runtime/clinical-pathway/` 结尾的 `brokerBaseUrl`；`runtimeTokenEnv` 指向服务端持有的运行时凭据。部署生成器仅在显式启用读取器时激活该行。不要在 profile 根挂载这些工具。

| 字段组 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` 及角色配置 | 显式提供 | 选择网关或 preset 工具；需要配置网关文件／来源，或工具的 broker 地址。 |
| `readRolePolicy` | `select-only` | 默认使用只读凭据；经明确确认的开发联调可在强制只读事务中复用现有角色。 |
| `maxRows`、`maxTextChars` | 200、12000 | 限制子记录及文书片段；请求分页大小另限 100。 |
| `maxRowBytes`、`maxResponseBytes` | 65536、262144 | 限制数据库 JSON 获取量及完整响应／模型输出，超限明确失败。 |
| `timeoutMs`、`maxConcurrentReads` | 30000、4 | 限制完整操作和网关并发；卸载取消并等待在途操作。 |
| `herbalTables`、`operationTables`、`dictionaryTables` | false | 核对 schema 和 SELECT 授权后显式启用可选来源。 |

[配置定义](src/config.ts)持有其余限额。读取失败保留已有对话依据。来源不可用不等于零计数或临床缺失；取消及超时给出可行动失败，不暴露 SQL 或凭据。

启用 `dictionaryTables` 时，还从 `v_cpoe_drug` 读取获准医院、本次返回医嘱代码的当前药品换算及皮试参数。这些是当前目录观察值，不代表历史版本参数；重复、缺失和未读完整的匹配均保留为缺口。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[网关](src/gateway.ts)接收认证运行时身份和当前登录检查。[策略](src/policy.ts)提供入院时间窗和科室范围，模型筛选只能缩小范围。[来源检查](src/source-check.ts)固定事务搜索路径，拒绝不兼容列或不安全角色。固定查询模块分别读取定义、去重历史人群和所选就诊类别；[公共查询处理](src/query.ts)在数据传给驱动前限制 JSON 字节。不执行用户提供的 SQL、标识符、身份或连接配置。

[工具](src/tools.ts)返回带版本的规范 JSON 及纯函数生成的通用读取／搜索卡片。普通 tool/result 和助手／用户消息将依据与参考稿修订留在私有 Session，现有对话和文件工具支持讨论、编辑和可选参考文件。不引入新的 Session 事件或持久化类型。单次快照不跨工具或分页，结果保留筛选、读取时间、范围、来源连接时区和覆盖。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [需求](../../../docs/requirements/clinical-pathway-assistant-v1.zh.md)——仅参考行为和验收。
- [实施计划](../../../docs/requirements/clinical-pathway-assistant-v1-implementation.zh.md)——来源字段、关联及交付状态。
- [托管工作区](../hosted-workspaces/README.zh.md)——认证私有运行时传输。
- [读取 broker](../emr-reader-broker/README.zh.md)——共享有界 PostgreSQL 事务。

-----

<a id="model-experience"></a>
## 模型体验

### 路径依据

#### 模型可见内容

`pathway_read` 搜索或展开确切定义。`history_query` 返回完整筛选队列的来源计数或有界依据分页，并明确分母。`case_read` 选择就诊、诊断、医嘱或已落地可读文书；文书目录和片段分别续读。记录到日志的规范 JSON 包含部分覆盖及未支持来源，不提供写入或审核工具。

#### Token 影响

只有请求的有界结果进入模型历史。连续分页及参考稿修订会增加上下文，截断及缺失依据保持可见，不暗示已完成全面核查。

#### KV Cache 影响

可选 preset 增加稳定的工具 schema 和参考说明。工具结果及对话修订追加普通历史；变更来源范围或启用读取器可能改变请求内容。不提供未记录到日志的私有模型输入。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

每次分析均保留当前限制。

- 未支持检验、检查、手术执行及给药来源。`record_text` 缺失不表示没有文书；对象存储正文及原生 FormV2 需要独立适配。
- 系统标记完成和医嘱记录不能证明临床任务完成。当前保留原因不是不可变的历史变异事件流。
- nullable 删除标记采用明确的来源规则，来源筛选及连接时区影响人群解释。不同分页／调用不共享全局快照。
- 参考质量仍需可查临床资料及用户验收。创建医院草案、写回、审核及发布不属于本阶段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
