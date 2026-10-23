# 自有插件与工具清单

只列本仓库相对上游新增的组件。包名称省略统一前缀 `@deepseek-ai/dsh-experimental-`；位置链接指向对应源码或目录。

| 名称 | 类型 | 位置 | 用途 |
|---|---|---|---|
| `hosted-workspaces` | 网关插件／Profile 组合包 | [packages/experimental/hosted-workspaces/](packages/experimental/hosted-workspaces/) | 公司 SSO 登录、每人独立的 Docker 工作区、文件与会话持久化，以及受限的模型请求代理。 |
| `emr-encounter` | 服务定义与共享类型包 | [packages/experimental/emr-encounter/](packages/experimental/emr-encounter/) | 定义就诊身份、授权绑定、证据快照及可替换的 `EncounterReader` 读取服务，不直接读取数据库。 |
| `emr-reader-broker` | 网关取数插件 | [packages/experimental/emr-reader-broker/](packages/experimental/emr-reader-broker/) | 按开发白名单校验就诊权限，只读获取 PostgreSQL 中的住院信息、诊断、医嘱和病历文书；数据库凭据留在网关。 |
| `clinical-review` | 临床核查插件 | [packages/experimental/clinical-review/](packages/experimental/clinical-review/) | 将授权就诊绑定到私人会话，采集证据、发起出院前核查、保存带原文引用的建议和报告；不写回 EMR、不阻断出院。 |
| `client-emr-entry` | Web 界面插件 | [packages/experimental/client-emr-entry/](packages/experimental/client-emr-entry/) | 提供接入就诊、开始核查、刷新证据和查询状态的界面，支持受信 EMR 窗口消息接入。 |
| `drg-resources` | 资料管理库 | [packages/experimental/drg-resources/](packages/experimental/drg-resources/) | 管理国家 DRG 原始 PDF、版本和校验摘要，支持只读共享、发布、默认版本选择、撤回与恢复；不含分组引擎。 |
| `review_load_case` | 模型工具（就诊会话内） | [packages/experimental/clinical-review/src/tools.ts](packages/experimental/clinical-review/src/tools.ts) | 分页读取当前授权就诊的证据清单、版本、采集时间和覆盖缺口。 |
| `review_read_evidence` | 模型工具（就诊会话内） | [packages/experimental/clinical-review/src/tools.ts](packages/experimental/clinical-review/src/tools.ts) | 按来源和偏移分段读取当前证据快照的原文。 |
| `review_submit_findings` | 模型工具（就诊会话内） | [packages/experimental/clinical-review/src/tools.ts](packages/experimental/clinical-review/src/tools.ts) | 提交不一致、信息缺失或待核实的问题建议；引用必须精确匹配已读原文，结论待人工确认。 |
| `review_get_report` | 模型工具（就诊会话内） | [packages/experimental/clinical-review/src/tools.ts](packages/experimental/clinical-review/src/tools.ts) | 读取当前核查报告及尚未核查的范围。 |
| `drg-national-reference` | 模型技能（Skill） | [deploy/hosted-workspaces/skills/drg-national-reference/SKILL.md](deploy/hosted-workspaces/skills/drg-national-reference/SKILL.md) | 指导模型复用已有文件和 Bash 工具读取共享国家 DRG PDF，校验版本并注明来源与页码；不计算 DRG／DIP 分组。 |
| `drg-resources.ts` | 运维脚本 | [scripts/drg-resources.ts](scripts/drg-resources.ts) | 提供资料集合的初始化、发布、列出、校验、设置默认版本、撤回、恢复和补登记操作。 |
| `company-presets.mjs` | 部署配置生成脚本 | [deploy/hosted-workspaces/company-presets.mjs](deploy/hosted-workspaces/company-presets.mjs) | 为 minimal、standard、PTC 和 Cordis 四种 Web 预设生成公司上下文压缩配置覆盖。 |
| 托管工作区部署配套 | 部署配置与构建脚本 | [deploy/hosted-workspaces/](deploy/hosted-workspaces/) | 提供 Docker 镜像构建、Compose 部署、运行时启动及临床核查和共享资料的可选配置。 |
