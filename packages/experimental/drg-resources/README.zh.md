---
description: "将国家 DRG 原始资料存为不可变的版本文件，并向用户私有运行时共享经过验证的来源元数据。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-drg-resources

[English](README.md) | 中文

## 概述

保留国家 DRG 原始 PDF，明确记录版本、整理修订和 SHA-256。每个修订只发布一次，校验原始字节和 SQLite 元数据，选择或撤回参考资料默认版本时不替换旧档案。用户私有运行时可通过 Docker 只读挂载读取同一份已发布集合。这些原件归档不含抽取后的分组规则、字典、引擎或患者数据；每份 manifest（元数据清单）均记录 `groupingReady: false`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 运维发布

在已安装依赖的仓库中使用离线资料工具。该工具创建和校验文件，不启动 DSH 应用或模型请求。使用以下命令查看准确的命令和选项列表：

```sh
pnpm exec tsx scripts/drg-resources.ts --help
```

在运维选定的持久化本地目录中初始化空集合，再检查结果。以下可丢弃示例使用独立临时目录：

```sh
drg_resource_root=$(mktemp -d)
pnpm exec tsx scripts/drg-resources.ts initialize --root "$drg_resource_root"
pnpm exec tsx scripts/drg-resources.ts list --root "$drg_resource_root"
```

`publish` 要求新的 `--id`、`--edition`、`--revision`、本地 `--source-file`、准确的 `--source-url`，以及独立核实的 `--sha256`。成功后输出原件归档 manifest，不选择默认版本。`default --id` 选择参考修订，`withdraw --id` 在必要时清除其默认选择，`restore --id` 恢复可用性但不选择默认版本。`verify` 校验完整集合；`verify --id` 对照目录摘要校验一个已登记修订。已发布 ID 无法覆盖，撤回后也不例外。

### 共享读取与权限

运维人员拥有 `<root>/staging` 和可变的发布目录元数据。只将 `<root>/published` 挂载到各个用户私有运行时，并使用 Docker 只读访问。预发布区、发布凭据、私有 home 和 Docker socket 均不属于该挂载。初始目录权限为 root/staging 的 `0700`、published 的 `0755`、完整包目录的 `0555`、不可变文件的 `0444`，以及可替换目录元数据的 `0644`；仍必须启用 Docker 只读约束。

读取方导入[库入口](src/index.ts)，调用 `readPublishedCollection(publishedRoot)` 或 `validatePack(publishedRoot, packId)`，获得有界元数据。SQLite 连接使用 `readOnly: true`；读取方不接受任意 SQL 或资料路径。`DrgResourceStore.read()` 在未提供 ID 时解析参考默认版本，拒绝缺失或已撤回的修订。本包不将资料绑定到 Session，也不暴露模型工具。

### 失败与恢复

每次发布或目录元数据更新都持有独占 `.writer-lock`。另一个写者会立即收到 `busy`。进程崩溃可能保留锁；只有已确认没有写者继续运行的运维人员才能删除陈旧锁。失败候选和状态收据保留在预发布区供检查。未知文件、符号链接、硬链接文件、损坏元数据、摘要变化及 SQLite WAL/SHM 依赖均无法通过校验。

完整目录可能在目录元数据更新失败后保留。该状态报告 `publication-incomplete`；`recover --id` 校验完整但未登记的目录，再登记为可用版本，不设为默认。应先检查目录元数据，因为在目录提交后收据或持久化工作失败时也可能报告未完成。发布处于目录落地与元数据提交之间时，整个集合的校验可能拒绝；只有写者结束并检查结果后才能重试。默认回滚选择旧的可用修订；撤回保留所有包文件。将全部保留包和目录元数据备份到服务器之外，并在使用前校验恢复后的集合。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

预发布区和发布区位于同一文件系统。发布器校验运维输入和预期 PDF 字节，创建只含来源及版本元数据的独立 DELETE 日志模式 SQLite 数据库，关闭写连接后验证完整候选。它同步文件和目录，将候选重命名为唯一的已发布目录，再原子替换目录元数据。发布只赋予参考资料可用性；严格 schema 会拒绝可执行分组就绪状态。

| 文件 | 职责 |
|---|---|
| [store.ts](src/store.ts) | 运维独占发布、目录默认选择、撤回和孤立包恢复 |
| [reader.ts](src/reader.ts) | 对已登记包和集合进行只读完整性校验 |
| [database.ts](src/database.ts) | 独立来源及版本元数据与只读 SQLite 校验 |
| [format.ts](src/format.ts) | 严格持久化格式和结构化运维错误 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DRG 需求](../../../docs/requirements/drg-review-assistant-v1.zh.md)——私有核查流程与完整引擎验收。
- [DRG 实施方案](../../../docs/requirements/drg-review-assistant-v1-implementation.zh.md#resources)——资料所有权与版本生命周期。
- [多用户工作区](../hosted-workspaces/README.zh.md)——私有 Docker 运行时与公司登录。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本库不注册模型可见工具或提示词，也不改变 Session 内容。

#### KV Cache 影响

没有直接影响；通过已有用户工具读取文件时，沿用该工具的日志记录和输出限制。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 要求可靠的本地文件系统重命名和目录 `fsync` 语义；网络文件系统、对象存储挂载及 Windows 发布均不属于支持的部署目标。
- 可信运维人员独占根目录及其父目录。文件哈希检测字节变化，不能确认来源真实性，也不能替代受控发布和备份。
- 原件归档不能对病例分组，也不能确认临床有效性。规则抽取、兼容字典、专业复核、引擎验收和 Session 版本绑定需要另行实现。
- 不自动删除陈旧锁或资料包，不提供远程下载、MinIO 分发或服务器部署。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
