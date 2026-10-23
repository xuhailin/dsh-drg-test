---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-clinical-review-trigger

[English](2026-10-22-clinical-review-trigger.md) | 中文

## 概述

在既有用户消息、开发者消息、收件箱插入及标题请求的持久化类型中，新增带事件 ID 和核查修订号的 clinical-review-trigger 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-clinical-review-trigger
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "79d675f8e1e3264ba3de4a10beaae93f69a525c72272eefe15527adfe10d0f90"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "522f01da29864a4599e5ad30275d2b62c9fc8b2d468f5036afc7ce9db0a15b65"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "307bd29eb8223ada5f930ae24fbf5050e7cfd340a1ba837bcbbdf4f0960f5f7e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "a7bce308e9f7f0343898e2f95bddbd8ef2e3db4694f81e183ecad3f399eabf5f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

写入格式保持 Session V4。新读者原样保留所有既有消息来源；没有临床插件记录的 Session 不具有临床绑定，也不会据此推断访问权限。既有 V4 读者接受除已退役 plugin 包装外的任意非空直接来源 kind，因此 clinical-review-trigger 及其元数据能在全部四个受影响消息位置解码后保留。对话渲染器将非 user 来源视作上下文或触发消息，标题消费方只识别精确的 user kind；新来源不会变成普通人工消息，也不会授予患者访问权限。这里保证已记录消息的保留和普通展示，不保证旧安装能执行临床工具。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts 的 10 个测试通过，覆盖未知直接来源 kind 及嵌套元数据的 V3 迁移和原生 V4 恢复。一次聚焦的本地 V4 编解码检查在全部四个受影响消息位置编码并严格解码 clinical-review-trigger，完整保留 kind、eventId 和 revision。clinical-review 聚焦测试的 20 个用例通过。

<a id="dev-note"></a>
## 开发备注

无。
