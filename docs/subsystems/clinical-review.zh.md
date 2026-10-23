# 临床就诊核查

[English](clinical-review.md) | 中文

实验性的[就诊资料读取器](../../packages/experimental/emr-encounter/README.zh.md) 通过 `ctx.encounterReader` 提供已授权的只读证据采集。[临床核查插件](../../packages/experimental/clinical-review/README.zh.md) 将私有 Session 绑定到一次就诊，并使用普通 DSH 轮次核查证据。核查结论仅供参考，绝不阻断出院。

## 账户与就诊绑定

`ClinicalActor` 使用运行时 ID、签发方和主体标识已认证账户。`EncounterBinding` 将该身份关联到已授权的数据源系统、医院和住院就诊。浏览器启动声明必须先经过服务端授权才能成为绑定；模型参数不能选择账户或替换绑定。[读取代理](../../packages/experimental/emr-reader-broker/README.zh.md) 负责当前的数据源授权与采集实现。

## 已授权目录

浏览器安全的[目录记录](../../packages/experimental/emr-encounter/src/directory.ts)以 `DepartmentDirectory` 承载已授权标签，以 `PatientDirectoryRequest` / `PatientDirectory` 承载有界在院患者分页。代理将科室授权绑定到精确的账号签发方、主体、来源系统、医院及科室。当前来源记录必须是状态为 `4` 或 `5` 的有效在院患者。浏览不增加权限，也不启动核查。[代理 README](../../packages/experimental/emr-reader-broker/README.zh.md)负责授权配置及查询限值。

## 证据快照

`EncounterSnapshot` 包含不可变的原始资料、分类覆盖情况、采集截止点，以及由内容生成的病例修订标识。资料状态和覆盖情况都参与修订计算。受支持的查询返回空结果只表示没有返回行，并不能证明临床事实不存在。采集失败或取消时不会发布已接受的部分快照。[源码类型](../../packages/experimental/emr-encounter/src/types.ts) 定义了交换字段。

## 已保存结果

[clinicalResults 投影](../../packages/experimental/clinical-review/src/result-projection.ts)从保留的 Session 插件记录恢复已接受报告及其原始快照，不改变持久化核查格式。版本化的[已保存结果记录](../../packages/experimental/clinical-review/src/result.ts) `ResultsResponse` 和 `ResultResponse` 区分逻辑结果、不可变报告修订、疑点身份、保留的来源引文、进度、覆盖及新鲜度。读取结果不调用模型或重新采集证据；历史快照不可用时明确标注。

每次读取已保存结果及重新核查均重新检查所属账号及当前就诊权限。精确就诊授权可不依赖临床数据库进行检查。科室授权必须读取当前住院记录，因此转科、出院、撤权或来源不可用时无法访问。后续核查失败不删除已接受报告。[展示插件](../../packages/experimental/client-clinical-results/README.zh.md)在聊天卡片、右侧面板及独立页面之间复用展示组件；未经核实的 EMR 导航保持不可用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxencounterreader--encounterreader-abstract-seam"></a>

### `ctx.encounterReader` — `EncounterReader` (abstract seam)

Providers reauthorize every capture and return immutable, bounded original evidence.

```ts cordis-catalog
/**
 * Capture one authorized encounter without modifying its source records.
 * @param actor - Authenticated transport identity; never model-selected.
 * @param binding - Previously accepted actor and encounter binding.
 * @param signal - Caller cancellation; dependent work stops before publication.
 * @returns Complete validated snapshot, or a typed failure with no accepted partial snapshot.
 */
abstract capture(actor: ClinicalActor, binding: EncounterBinding, signal: AbortSignal): Promise<EncounterSnapshot>
```

Source: [`packages/experimental/emr-encounter/src/index.ts`](../../packages/experimental/emr-encounter/src/index.ts)
<!-- END GENERATED cordis-surface -->
