# 临床就诊核查

[English](clinical-review.md) | 中文

实验性的[就诊资料读取器](../../packages/experimental/emr-encounter/README.zh.md) 通过 `ctx.encounterReader` 提供已授权的只读证据采集。[临床核查插件](../../packages/experimental/clinical-review/README.zh.md) 将私有 Session 绑定到一次就诊，并使用普通 DSH 轮次核查证据。核查结论仅供参考，绝不阻断出院。

## 账户与就诊绑定

`ClinicalActor` 使用运行时 ID、签发方和主体标识已认证账户。`EncounterBinding` 将该身份关联到已授权的数据源系统、医院和住院就诊。浏览器启动声明必须先经过服务端授权才能成为绑定；模型参数不能选择账户或替换绑定。[读取代理](../../packages/experimental/emr-reader-broker/README.zh.md) 负责当前的数据源授权与采集实现。

## 证据快照

`EncounterSnapshot` 包含不可变的原始资料、分类覆盖情况、采集截止点，以及由内容生成的病例修订标识。资料状态和覆盖情况都参与修订计算。受支持的查询返回空结果只表示没有返回行，并不能证明临床事实不存在。采集失败或取消时不会发布已接受的部分快照。[源码类型](../../packages/experimental/emr-encounter/src/types.ts) 定义了交换字段。

核查插件通过 Session 插件记录保存绑定、快照、操作和结论。报告属于精确的病例修订；刷新证据后，需要重新核查才能展示当前结论。包 README 负责说明报告校验、授权时效及恢复限制。

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
