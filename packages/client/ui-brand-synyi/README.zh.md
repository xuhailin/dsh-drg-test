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

Web 应用 bundle 挂载本插件以替代 `ui-brand-official`。本插件适用于所有客户端构建 profile，没有配置字段。

侧栏和欢迎页使用 EMR 提供的森亿标志。品牌名称在浅色和深色模式下均使用共享主题的文字颜色。浏览器图标与安装元数据由 `apps/web` 持有。完整仓库构建默认使用“森亿智能”作为文档标题；构建时可通过 `DSH_CLIENT_TITLE` 覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器入口等待各所属 slot 声明后提供品牌图形。侧栏标志与名称一起注册，欢迎页标志独立注册。声明卸载和插件销毁都会移除相应填充。node 入口不提供 Host 行为。内置 PNG 保留所提供的森亿原始图形。

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
- **浏览器元数据独立**——slot 填充不改变浏览器标题、favicon 或安装 manifest。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
