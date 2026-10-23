---
description: "为 Web profile 提供可选森亿品牌和主题，页面标题由部署负责，Agent 工具保持原配置。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-synyi-web-app

[English](README.md) | 中文

## 概述

此可选层为标准 Web profile 提供森亿品牌、页面资源、配色和紧凑圆角。托管工作区启动器在部署专用 patch 之前应用它。普通 Web bundle 保留上游展示方式。Agent 工具和临床行为继续由现有 preset 及插件负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

[托管部署](../../../deploy/hosted-workspaces/entrypoint.sh) 通过 `dsh --patch` 应用本包的 `cordis.patch.yml`，包括已有的托管 profile，不重写已保存的 profile 清单。[镜像构建](../../../deploy/hosted-workspaces/Dockerfile) 通过现有构建环境传入 `DSH_CLIENT_TITLE=森亿智能`。

在已构建的仓库中，可在本地应用同一层：

```sh
pnpm dsh web --patch packages/bundle/synyi-web-app/cordis.patch.yml
```

页面标题来自构建产物。需要匹配此品牌时，使用 `DSH_CLIENT_TITLE=森亿智能 pnpm run build:artifacts` 构建。自定义 profile 也可以在 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 之后列入本 bundle；三个包都必须能够从该 profile 解析。展示层只应用一次。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[Patch](cordis.patch.yml) 禁用 `ui-brand-official`，插入 `ui-brand-synyi` 和 `ui-theme-synyi`。品牌插件负责槽位内容、favicon 路由和 manifest 链接；主题插件负责 token 覆盖及首屏样式。禁用官方内容可避免同一品牌槽位发生重复注册。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [品牌插件](../../client/ui-brand-synyi/README.zh.md)
- [主题插件](../../client/ui-theme-synyi/README.zh.md)
- [Profile 组合](../../boot/app-boot/README.zh.md)

<a id="model-experience"></a>
## 模型体验

无，本 bundle 仅贡献展示内容，不向模型请求添加任何内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **需要 Web 组合** — 此层依赖标准 Web 组合及其现有槽位名称。
- **构建时标题** — shell 和客户端 bundle 共用同一构建值。
- **仅限 Web** — 此层不改变独立静态 worker 或 Desktop 组合。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
