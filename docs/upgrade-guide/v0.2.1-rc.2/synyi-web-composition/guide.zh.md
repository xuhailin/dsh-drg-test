---
kind: upgrade-guide
description: "森亿展示从默认 Web 配置迁移到显式启用的可选 bundle。"
---

# 显式选择森亿 Web 组合

[English](guide.md) | 中文

## 变更

此 fork 的普通 `web` profile 使用上游品牌和主题默认值。森亿展示由 `@deepseek-ai/dsh-synyi-web-app` 负责；标题使用已有的 `DSH_CLIENT_TITLE` 构建变量。托管工作区启动器自动应用森亿 patch，Dockerfile 传入标题。

托管临床 overlay 为新会话选择生成的 `clinical-review` preset。已有会话保留记录的 preset 和报告历史。患者授权及通用工具不变。

## 迁移

1. 从源码启动 Web 时，使用 `DSH_CLIENT_TITLE=森亿智能 pnpm run build:artifacts` 构建，再运行 `pnpm dsh web --patch packages/bundle/synyi-web-app/cordis.patch.yml`。自定义 profile 参见 [bundle 参考](../../../../packages/bundle/synyi-web-app/README.zh.md)。此层只应用一次，并放在标准 Web bundle 之后。
2. 托管镜像使用配套的当前 Dockerfile 和 entrypoint。配置的运行时 overlay 选用临床 preset 时，entrypoint 会先生成该 preset，再应用公司模型覆盖。直接启动临床 overlay 的运维人员必须先生成并加载其 preset；参见 [临床核查](../../../../packages/experimental/clinical-review/README.zh.md)。
3. 确认新临床会话记录 `clinical-review`，旧报告仍可读取，品牌页面保留图标及浅／深色外观。加载 preset 不会迁移已有会话。应用组合与留存会话数据分别回滚。
