---
description: "为 Synyi Web 临床部署提供配色、紧凑圆角与一致的启动背景。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme-synyi

[English](README.md) | 中文

## 概述

本包为 Synyi Web 部署提供蓝色操作、冷灰工作区、紧凑圆角，以及与浅色和深色模式一致的启动背景。用户继续使用标准浅色、深色、跟随系统的主题偏好与字体设置。Synyi 临床应用可在标准主题旁启用本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在部署组合中，将本插件与 `@deepseek-ai/dsh-client-ui-theme` 一起挂载。本插件没有配置字段。它改变浏览器应用的展示，不属于单个 agent preset。

```yaml
- name: '@deepseek-ai/dsh-client-ui-theme-synyi'
  id: ui-theme-synyi
```

标准主题负责持久化偏好与字体设置。本插件跟随这些偏好，不注册或保存另一个主题 id。停用时会移除自身的 token 层，并保留此前已有的层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

同一份浅／深色 token 字典同时用于启动与 Client 渲染。head CSS 通过 `light-dark()` 与标准主题已解析的配色模式，在 body 脚本执行前选择启动背景。Host 随后读取标准启动代码的 body 色板属性并同步设置 token。Client 通过 `ctx.theme.overrideTokens` 注册相同字典；标准布局展示器负责应用更新，并在停用时撤回该层。配色、圆角、渐变与菜单材质均由本包维护。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [标准主题](../ui-theme/README.zh.md) — 偏好、字体与 token 覆盖。
- [Web server](../../host/webserver/README.zh.md) — index 注入生命周期。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md) — 浏览器插件组合。

-----

<a id="model-experience"></a>
## Model Experience

None, as the package changes browser presentation without adding model context, tools, or Session events.

#### KV Cache effect

None; 主题激活不会组装模型请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

色板跟随单一部署身份。

- **需要标准主题** — 启动配色选择使用其 body 启动代码，Client 激活依赖其 `theme` 服务。
- **浏览器元数据独立** — 本包不修改标题、favicon 或安装 manifest。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
