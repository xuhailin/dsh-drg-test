---
description: "以 EMR 共享定义保存私有路径参考修订，并提供轻量预览。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-clinical-pathway-reference

[English](README.md) | 中文

## 摘要

P1 在私有 Session 保存新建或确切来源的参考任务。EMR 拥有临床数据定义，DSH 拥有参考修订、依据、锁和只读预览。医院写入与 EMR 完整手工编辑器不属于本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

挂载[可选运行时补丁](../../../deploy/hosted-workspaces/clinical-pathway.runtime.patch.yml)，配置与独立获准的路径读取器一致的范围，以及请求、历史和字节上限。组合临床配置挂载同一参考稿服务，普通配置不启用它。通过 `dsh` profile 启动。在 `clinical-pathway-analysis` 对话打开“参考稿”即可建立或查看任务。

经认证的 `api/pathway-reference` 路由提供 config、read、create、commit 和 undo。修订任务选择已记录的确切 `pathway_read` 结果，保留原始来源身份和读取时间。新任务的临床参数未知、集合为空。保存等待 Session 持久化；结果不明时阻止后续操作直至恢复。分叉保留原所有者，不继承参考任务访问权。

<a id="understand-the-implementation"></a>
## 理解实现

[EMR 镜像记录](src/emr/source.json)保存 schema、生成声明、生成 schema 值与独立读取器的内容摘要。在本包执行 `node scripts/sync-emr-definition.mjs --emr-root <emr-checkout>` 同步，增加 `--check` 校验。仅为 DSH 调整导入扩展名，定义正本仍由 EMR 拥有。[导入器](src/import.ts)对已记录来源行转换一次，保留未知值和可定位缺口。原始行仍保留在 Session。

[状态服务](src/state.ts)串行处理操作、核验所有者／预设／范围并追加完整私有插件记录。三路提交保留独立字段，拒绝已变化的依赖或锁。撤回生成补偿修订。轻量修订投影刷新已打开的预览；临床正文在持久化确认后返回。刷新失败保留最近确认的内容。

<a id="further-exploration"></a>
## 进一步探索

- [P1 需求](../../../docs/requirements/clinical-pathway-workbench-p1-draft.zh.md)
- [共享数据要求](../../../docs/requirements/clinical-pathway-workbench-model.zh.md)
- [来源读取器](../clinical-pathway-reader/README.zh.md)

<a id="model-experience"></a>
## 模型体验

<a id="reference-operations"></a>
### 参考操作

#### 模型看到的内容

预设内的 `pathway_reference` 工具读取、建立、提交或撤回参考稿。所有模型可见结果都使用正常的已记录工具输出。候选定义必须采用 EMR 格式／版本和稳定本地身份。模型不能更改用户锁，包括通过撤回操作。

#### Token 影响

完整定义及历史按数据大小消耗 token；字节与修订上限在保存前拒绝超限操作。

#### KV Cache 影响

预设增加稳定的参考稿工具定义。读取和保存变更追加普通工具历史，参考内容变化会改变请求内容；临床数据不通过已记录工具结果之外的途径注入。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 预览展示临床字段与 JSON，不提供临床编辑表单。P2 接入前，EMR 编辑入口明确不可用。P4 提案生成／选择和 P5 交接另行实施。来源覆盖缺口持续可见；参考定义校验不代表临床正确或满足医院写入条件。所附分析时间窗为显式配置，需与读取策略一同维护。

<a id="dev-note"></a>
### 开发备注

合成数据的定义、导入、修订、UI 和 Loader 验证覆盖 P1，不依赖医院数据库。真实临床校验与用户业务验收另行完成。
