---
description: "通过仅网关持有的 PostgreSQL 读取器获取白名单 EMR 开发病例，不改变出院流程。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-emr-reader-broker

[English](README.md) | 中文

## 概述

浏览明确授权的开发科室与在院患者、打开就诊，只读捕获就诊、诊断、医嘱及文书证据。个人运行实例仅接收其获准访问的就诊资料；数据库凭据与绑定密钥留在网关。缺失文书正文及不支持的来源会明确标出。此开发白名单不等于医院生产权限控制。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将此插件与 hosted workspaces 一起挂载在专用网关组合中。它没有独立可执行入口，也不是配置组合包。运行实例事件提供已验证账号及实时登录检查；代理拒绝过期会话，并在返回证据前重新校验授权。

```yaml
- name: '@deepseek-ai/dsh-experimental-emr-reader-broker'
  config:
    sourceSystem: emr-pg-develop
    databaseConfigFile: /run/secrets/emr-database.json
    allowlistFile: /run/secrets/emr-allowlist.json
    bindingKeyFile: /run/secrets/emr-binding-key
```

数据库文件为 JSON，包含 `host`、`port`、`database`、`user`、`password` 及可选布尔值 `ssl`。使用仅有 SELECT 权限的专用账号。每次捕获还会开启 `REPEATABLE READ READ ONLY` 事务。绑定密钥文件至少包含 32 个字符；重启时保持稳定，轮换后旧绑定失效。这些文件仅挂载到网关，并由运维控制权限。

白名单 JSON 包含 `schemaVersion: 1`、`entries` 及可选的 `departments`。精确就诊记录必须包含 `issuer`、`subject`、`sourceSystem`、`hospitalCode` 及十进制字符串 `inpatId`；`inpatCode` 和 `sourceVisitId` 为可选的已核实映射。科室授权包含相同的账号、来源和医院字段，以及 `departmentCode`，仅允许来源状态为 `4` 或 `5` 的有效在院患者。代理在每次操作时重读策略。授权列表均为空时不允许访问；格式错误或重复授权会拒绝访问。精确就诊授权独立有效，将其替换为仅科室授权时必须移除对应精确记录。

[配置校验](src/config.ts)拥有所有限值。默认每个受支持类别允许 500 条记录、目录每页 50 名患者、每条来源正文 256 KiB、完整响应 4 MiB，请求期限 15 秒、并发请求 4 个。任一捕获限值超出都拒绝本次捕获，不接受截断快照。

启动操作校验声明的标识，返回绑定账号、有效五分钟的一次性凭据。消费操作将其换成经认证的就诊绑定；捕获操作再次校验绑定及当前白名单。启动凭据仅保留在内存中，重启后失效。启动事件不修改出院事务、不创建模型请求，也不建立医院授权策略。

[目录](src/directory.ts)仅列出已授权科室，采用字面搜索及 SQL 绑定值分页读取其在院患者。仅返回就诊标识、患者姓名及床位；浏览不创建模型请求或额外权限。`/authorize` 检查已签名绑定，不重新采集证据。精确就诊授权的此项检查无需读库；科室授权必须读取当前住院记录，转科、出院、撤权或来源不可用时拒绝访问。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[代理](src/http.ts)拥有固定的 `/runtime/emr/launch`、`/runtime/emr/consume`、`/runtime/emr/authorize`、`/runtime/emr/capture`、`/runtime/emr/departments` 及 `/runtime/emr/patients` POST 路由。[授权](src/policy.ts)使用仅网关持有的 HMAC 密钥认证绑定字段。[固定 SQL](src/sql.ts)采用参数值选择明确列、校验医院归属，并通过文书主记录关联正文。不接受任意 SQL、路径、URL 或医生身份覆盖。

[读取器](src/reader.ts)将保存的原始内容、来源元数据、覆盖情况、绑定及提供方版本计算为 `caseRevision`；证据未变时，不同采集时间保持相同版本。`capturedAt` 和 `cutoff` 独立记录本次采集时间。不可用文书正文标为未读，医嘱状态与实际执行证据保持区分。发布前拒绝超限，每条查询前重验登录，并在返回前重读授权。取消会关闭来源连接；卸载会停止请求并移除运行实例处理器。

本包还向可选[路径读取器](../clinical-pathway-reader/README.zh.md)导出 `PgReadDatabase`、`ReadDatabase`／`ReadTransaction` 类型、`databaseConfigSchema`、`readBoundedFile` 及 `readClinicalRequestBody` 及 `writeClinicalReadFailure`。这些辅助能力不注册路由或扩大就诊策略；消费者持有固定 SQL、来源／schema 核对、授权及完整结果限额。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [就诊读取服务定义](../emr-encounter/README.zh.md) — 可替换提供方语义。
- [Hosted workspaces](../hosted-workspaces/README.zh.md) — SSO 与个人运行实例。
- [临床插件设计](../../../docs/requirements/drg-review-assistant-v1-plugins.zh.md) — 证据核查与 Session 所有权。

<a id="model-experience"></a>
## 模型体验

无，因为此代理不注册模型工具、提示词或 Session 内容。

#### KV 缓存影响

没有直接影响；临床核查消费方负责记录证据及组织模型上下文。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 白名单仅授权开发就诊。生产部署需要核实医院患者权限策略和可信 EMR 事件授权。
- 检验、检查、手术及实际执行来源暂不支持。正文缺失不代表文书不存在；签署数据与编辑器未保存草稿需要分别处理。
- SQL 面向已核实的 EMR PostgreSQL 结构。其他数据库布局与临床 MCP 提供方需要明确适配器，不通过回退改变来源语义。
- 来源记录为数据库当前快照，不提供历史重放。此包不计算 DRG/DIP 病组、不写 EMR 记录，也不上报医保。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
