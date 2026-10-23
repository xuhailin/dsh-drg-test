---
kind: upgrade-guide
description: "森亿展示从默认 Web 配置迁移到显式启用的可选 bundle。"
---

# 显式选择森亿 Web 组合

[English](guide.md) | 中文

## 变更

此 fork 的普通 `web` profile 使用上游品牌和主题默认值。森亿展示由 `@deepseek-ai/dsh-synyi-web-app` 负责；标题使用已有的 `DSH_CLIENT_TITLE` 构建变量。托管工作区启动器自动应用森亿 patch，Dockerfile 传入标题。

托管临床 overlay 为新会话选择显示为“医保助手”的 `clinical-review`。显式 `clinical.preset.yml` 取代此前从 Standard 派生的方式：不加载项目开发指令和编程计划模式，`clinical-prompt.mjs` 在临床作用域内排除 Harness 开发上下文。通用工具、公司模型策略及患者授权保留。已有会话保留 preset 标识和报告历史；重启 `clinical-review` 会话时使用当前定义，Standard 会话仍使用 Standard。

## 迁移

1. 从源码启动 Web 时，使用 `DSH_CLIENT_TITLE=森亿智能 pnpm run build:artifacts` 构建，再运行 `pnpm dsh web --patch packages/bundle/synyi-web-app/cordis.patch.yml`。自定义 profile 参见 [bundle 参考](../../../../packages/bundle/synyi-web-app/README.zh.md)。此层只应用一次，并放在标准 Web bundle 之后。
2. 托管镜像将 `deploy/hosted-workspaces/clinical.preset.yml` 和 `clinical-prompt.mjs` 与当前生成器及 entrypoint 配套安装。运行时 overlay 选用临床 preset 时，entrypoint 会先加载临床声明，再应用公司模型覆盖。直接启动临床 overlay 的运维人员必须先生成并加载其 preset；参见 [临床核查](../../../../packages/experimental/clinical-review/README.zh.md)。构建临床产品的页面标题时使用 `DSH_CLIENT_TITLE=医保助手`。
3. 确认新临床会话记录 `clinical-review`，欢迎文案为“医保助手”，完整提示不含项目开发和编程计划指令，同时保留通用工具。确认旧报告仍可读取，页面保留图标及浅／深色外观。加载 preset 不会重写留存日志或转换 Standard 会话。应用组合与留存会话数据分别回滚。
