---
description: "为侧栏和欢迎页提供森亿标志与本地化名称；供采用森亿品牌的部署阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-synyi

[English](README.md) | 中文

## 概述

本包在侧栏和会话欢迎页展示森亿标志。侧栏名称跟随所选语言：中文显示“森亿智能”，英文显示“SYNYI AI”。采用森亿品牌的部署可选择本包；它不改变模型请求或功能图标。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过部署 bundle 或 profile patch 挂载本插件，并在该组合中禁用 `ui-brand-official`。默认 Web bundle 保留官方品牌。本插件依赖 Host Web 服务器，没有配置字段。

侧栏和欢迎页使用 EMR 提供的森亿标志。品牌名称在浅色和深色模式下均使用共享主题的文字颜色。Host 在 `synyi-brand/` 下提供本包的浅色/深色 favicon 与安装 manifest，并替换应用外壳的品牌链接。相对 URL 保留反向代理的应用路径。部署使用默认构建 profile 完整构建时设置 `DSH_CLIENT_TITLE=森亿智能`；官方构建 profile 保留官方标题。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器入口等待各所属 slot 声明后提供品牌图形。侧栏标志与名称一起注册，欢迎页标志独立注册。声明卸载和插件销毁都会移除相应填充。Host 在激活时加载包内资源，缺失文件会使激活失败。GET 与 HEAD 提供这些资源，其他方法返回 405；插件销毁时移除路由和 index 转换。内置 PNG 保留所提供的森亿原始图形。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-sidebar](../ui-sidebar/README.zh.md)——侧栏品牌 slot 与回退呈现。
- [ui-conversation](../ui-conversation/README.zh.md)——会话欢迎页。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件组合。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只提供浏览器品牌呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

品牌呈现使用单一部署身份。

- **一个品牌插件**——不要为相同品牌 slot 挂载其他填充。
- **标题在构建时确定**——部署为 Web 外壳和客户端插件提供相同的 `DSH_CLIENT_TITLE`；仅加载品牌插件不会改变文档标题。
- **需要 HTTP 外壳**——资源路由与元数据替换适用于 Host 提供的 Web 文档；独立静态 worker 外壳不会执行 index 转换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
