---
description: "公司 SSO 入口、私有 Docker 工作区，以及受限制的共享 Key 模型访问。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-hosted-workspaces

[English](README.md) | 中文

## 概述

提供公司账号登录入口，为每个账号分配私有 DSH Web 环境。仓库 Docker 镜像提供独立的 gateway profile；普通 profile 不启用此组合层。个人容器保留聊天、文件、终端和工具交互，独立的模型代理持有上游 Key。此实验性部署需要 Docker 控制权限和分别隔离的浏览器 origin；本地 mock 检查不能证明其适合处理患者数据。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

按照 [Docker 试用指南](../../../docs/user/guide/hosted-workspaces.zh.md)构建仓库镜像，并启动公司账号登录入口。本地组合提供 mock OIDC 和模型服务，无需公司服务器、已注册的 SSO 应用或真实 API Key。

### 仓库镜像提供的 profile

镜像包含此工作区包及独立的 [gateway profile manifest（元数据清单）](../../../deploy/hosted-workspaces/profile/package.json)。入口脚本通过 `dsh --profile gateway` 启动该 profile；每个个人容器启动既有 `web` profile。本仓库试用流程不通过包注册表安装此包。

组合包的[补丁](cordis.patch.yml)挂载自己的 Web 服务器、网关存储和登录插件。请将它保留在独立的 gateway profile 中：它拥有该服务器的兜底路由，且不组合 agent（智能体）。个人运行实例拥有既有的 Web 工具和设置。

<a id="configuration"></a>
### 配置

[配置 schema](src/config.ts)拥有完整字段列表。补丁读取部署环境变量；Compose 提供入口配置，以及仅挂载到网关的密钥文件。

| 输入 | 默认值 | 含义 |
|---|---|---|
| `publicOrigin` | 必填 | 不带路径的入口 origin；个人 origin 使用其直接子域名 |
| `issuer`, `clientId` | 必填 | 已注册的 OIDC 提供方和应用 |
| `discoveryUrl` | 从 issuer 发现 | 可选的内部发现 URL；返回的 issuer 仍须匹配 |
| `oidcFlow` | `authorization-code` | 授权码登录；仅返回 ID token 的提供方可使用 `implicit` |
| `clientSecretFile` | 未设置 | 仅网关读取的授权码机密客户端密钥；implicit 模式忽略此项 |
| `deepseekKeyFile` | 必填 | 仅挂载到网关的上游 Key 文件 |
| `deepseekBaseUrl` | `https://api.deepseek.com/anthropic` | 兼容 Messages 的上游接口 |
| `allowedModels` | `deepseek-flash`, `deepseek-v4-pro` | 共享 Key 代理允许使用的模型 |
| `allowHttp` | `false` | 显式允许仅供开发的 HTTP；本地 Compose 试用会启用 |
| `sessionTtlMs`, `flowTtlMs` | 12 小时、5 分钟 | 浏览器会话和登录尝试的绝对有效期 |
| `maxCallbackBytes` | 64 KiB | token 解析与验证前允许的 implicit 回调请求体上限 |
| `maxUsers`, `maxBrowserSessions` | `20`, `200` | 持久化账号数和有效浏览器会话数限制 |
| `containerMemoryBytes`, `containerNanoCpus`, `containerPidsLimit` | 2 GiB、2 CPU、`256` | 应用于每个个人容器的限制 |
| `containerTmpBytes` | 256 MiB | 个人容器 `/tmp` tmpfs 大小 |
| `maxRequestsPerWindow`, `rateWindowMs`, `maxConcurrentModelRequests` | `30`、60 秒、`2` | 每个账号使用共享 Key 的模型请求限制 |
| `maxModelRequestBytes`, `maxOutputTokens` | 32 MiB、`256000` | 模型请求字节数和请求输出 token 上限 |
| `maxIndexResponseBytes`, `maxProxyConnectionsPerUser` | 2 MiB、`64` | 解码并修改后的 index 字节数，以及同时存在的个人代理连接数 |

### 身份和保留的工作

网关从经过验证的 OIDC issuer 和 subject 推导账号。它根据自己的账号记录选择个人运行实例，校验浏览器 origin，并用仅供后端使用的 DSH cookie 替换浏览器凭据。运行实例凭据仅授权模型代理允许的操作；上游 Key 不进入个人容器。

退出登录会撤销对应浏览器会话，并关闭该会话获准建立的连接。个人数据和后台工作会保留，公司身份提供方的会话不会退出。网关重启会保留账号记录及既有容器；必须将网关存储与个人数据卷一起备份。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

网关默认使用 PKCE、nonce 和绑定浏览器的 state 完成授权码登录。implicit 兼容模式仅请求 `id_token`；回调页面移除 URL fragment，再通过同源 POST 提交，由服务端验证签名、issuer、audience、有效期、nonce 和 state。两种模式均不使用密码授权，也不请求 EMR 业务 access token。DSH 不将 ID token 或 access token 保存到 localStorage。[注册指南](../../../docs/user/guide/hosted-workspaces.zh.md#sso-registration)拥有提供方设置。

网关通过短时、一次性的交接，将验证后的浏览器会话转移到该账号独立的 origin。implicit fragment 中转页将表单限制为 CSP `form-action 'self'`。其 POST 返回使用 `form-action 'none'` 的入口 HTTP 200 页面，由 meta refresh 导航到该交接地址。交接返回一个文档，由该文档发起新的同源导航，结束身份提供方的重定向链。账号／退出栏在 DSH 应用上方预留空间。HTTP 和 WebSocket 请求只会到达该有效会话所选择的运行实例。

Docker 控制请求使用配置的 `dockerSocket`，即使环境定义了 `DOCKER_HOST` 或 Docker TLS 设置。Docker 为每个账号分配一个命名 home 数据卷和桥接网络。启动流程在复用资源前检查既有资源的归属和隔离配置。模型代理监听网关在个人网络中的具体地址，并在用户容器之外执行请求限制。启动失败会删除本次操作创建的资源；清理失败需要运维人员检查。

| 源文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml), [`src/index.ts`](src/index.ts) | 独立 profile 组合和生命周期归属 |
| [`src/oidc.ts`](src/oidc.ts), [`src/state.ts`](src/state.ts) | 经验证的身份、持久化账号和可撤销会话 |
| [`src/gateway.ts`](src/gateway.ts), [`src/proxy.ts`](src/proxy.ts) | origin 准入、路由、流式传输和连接关闭 |
| [`src/docker.ts`](src/docker.ts), [`src/model.ts`](src/model.ts) | 个人 Docker 资源和受限制的上游 Key 使用 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Docker 试用和 SSO 注册](../../../docs/user/guide/hosted-workspaces.zh.md)——本地启动、公司配置和验收场景。
- [实验性包](../README.zh.md)——支持状态和包的选择。
- [Web 应用](../../bundle/web-app/README.zh.md)——个人运行实例的既有浏览器界面。
- [公开部署](../../../docs/user/guide/public-deployments.zh.md)——外部 Host、TLS 和 WebSocket 转发。

-----

<a id="model-experience"></a>
## 模型体验

### 转发的模型请求

#### 模型看到的内容

个人 Web profile 拥有提示词、工具和已记录的对话内容。此组合层转发获准的 Messages 请求，不添加提示文本或工具 schema。它仅接受流式 `POST /model/v1/messages`；Files 操作和上游文件引用会被拒绝。

#### Token 影响

网关不添加模型输入 token。个人运行实例的既有上下文和工具决定 token 用量；代理限制请求中的 `max_tokens` 值，并仅允许配置的模型 ID。

#### KV Cache 影响

网关不添加缓存前缀或缓存控制字段。个人运行实例和上游提供方决定转发请求的缓存复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **实验性试用**——真实公司 SSO、真实 DeepSeek 流式请求，以及部署环境的隔离需要另行验收；此组合层不宣称可用于生产或患者数据。
- **磁盘配额需要宿主机配置**——此处不为 Docker 命名卷强制执行每账号硬配额。在允许访问共享服务器存储前，须配置并验证 Linux 文件系统／项目配额。
- **单网关实例**——待完成的登录流程、连接跟踪和运行实例启动归属保留在进程内；不支持副本和分布式准入。
- **保留后台工作**——退出登录不会停止工具或容器，也不提供空闲停止策略。运维人员负责保留、备份及最终资源清理。
- **不提供 Files API**——在依赖图片附件前，须验证图片内联回退经过真实个人运行实例的端到端流程。
- **Linux 工具可用性**——已安装程序、集成和容器权限决定哪些 Web profile 工具能够运行；此镜像不提供桌面专属操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

[需求验证记录](../../../docs/requirements/sso-private-workspaces-v1.zh.md#dev-note) 统一记录已执行的本地检查及其限制。公司 SSO 注册、服务器部署及独立用户验收均未执行。

</details>
