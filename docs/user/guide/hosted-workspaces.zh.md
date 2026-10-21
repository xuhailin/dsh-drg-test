---
description: "在本地 Docker 中试用公司账号登录和个人 DSH 工作区，并准备 OIDC 应用注册。"
---

# 公司账号登录与个人 Docker 工作区

[English](hosted-workspaces.md) | 中文

## 概要

在选择服务器和域名前，先通过本地 Docker 引擎试用公司式登录和私有 DSH 聊天。本地试用提供 mock 身份与模型服务，无需公司凭据或真实 API Key。每个账号获得独立的浏览器 origin、DSH 容器和持久化 home 数据卷。共享服务试用前，仍须分别完成公司 SSO 注册、真实模型验收和 Linux 部署控制。

## 目录

- [运行本地试用](#local-trial)
- [使用 GitLab CI 构建镜像](#gitlab-ci)
- [注册公司 SSO 应用](#sso-registration)
- [连接公司服务](#company-services)
- [隔离与运行限制](#isolation-and-limits)
- [验证与恢复](#verification-and-recovery)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="local-trial"></a>
## 运行本地试用

从本仓库 checkout 开始，确保 Docker Engine 或 Docker Desktop 正在运行，并可使用 Docker Compose。预留本地 `8080` 和 `8090` 端口。浏览器须将 `chat.localhost` 及其子域名解析到本机。

### 构建和启动

在仓库根目录运行下列命令。镜像构建会安装工作区依赖并构建 DSH，需要网络访问，可能耗时数分钟。

```sh
sh deploy/hosted-workspaces/build-image.sh
docker compose -f deploy/hosted-workspaces/compose.yml -f deploy/hosted-workspaces/compose.test.yml up -d
docker compose -f deploy/hosted-workspaces/compose.yml -f deploy/hosted-workspaces/compose.test.yml ps
```

测试覆盖配置选择 mock OIDC 和模型服务，并挂载合成 fixture（测试前置数据）密钥。它不连接公司 SSO 或 DeepSeek。此覆盖配置仅用于本地合成数据。

### 试用两个账号

打开[本地入口](http://chat.localhost:8080)，选择公司账号登录，并在 mock SSO 页面点击 **Sign in as Alice**。浏览器应回到类似 `http://u-<40-hex-characters>.chat.localhost:8080` 的 origin，显示既有 DSH 聊天界面以及账号／退出控件。首次访问还会启动 Alice 的个人容器。

发送一条简短聊天消息。mock 回复以 `Mock DeepSeek:` 开头。工具流程可发送 `WRITE_MARKER alice.txt`，并响应正常的 DSH 审批。mock 模型会请求真实 Bash 工具，在个人工作区写入并读取标记文件。

使用另一个浏览器 profile 或隐私窗口，以 **Bob** 登录。Bob 应获得不同的 origin 和空的独立工作区。再发送 `WRITE_MARKER bob.txt`，然后检查下文的隔离和退出场景；这些预期结果在验证记录确认执行前仍属于验收目标。

### 停止本地入口

停止 Compose 服务，同时保留其命名卷：

```sh
docker compose -f deploy/hosted-workspaces/compose.yml -f deploy/hosted-workspaces/compose.test.yml down
```

个人容器通过 Docker 创建，不由 Compose 管理；这些容器及其数据卷会保留。后台工作可以继续运行，但已停止的模型网关不可用。运维人员须单独管理这些资源。不得在保留个人数据卷和容器的同时，单独删除网关的账号数据卷。

-----

<a id="gitlab-ci"></a>
## 使用 GitLab CI 构建镜像

仓库的 [GitLab 流水线](../../../.gitlab-ci.yml)在分支推送和合并请求中检查 hosted-workspaces。受保护的默认分支构建以提交标识为标签的镜像，但不上传；其他受保护分支提供手动镜像任务。既有 Python 发包任务仍仅由 Python 发布标签触发。服务器部署与 SSO 注册须单独配置。

使用 Linux amd64、Docker executor 的 Runner，标签由 `HOSTED_CI_RUNNER_TAG` 指定（默认 `rm-executor`，匹配公司共享 Linux Runner）。使用其他 Runner 时覆盖此变量。镜像构建使用 rootless BuildKit，任务中不挂载 Docker socket，也不启动 DinD 服务。Runner 必须允许其用户命名空间与挂载操作；按 Runner 配置核对 [GitLab BuildKit 要求](https://docs.gitlab.com/ci/docker/using_buildkit/)，并检查镜像任务结果。

镜像任务将官方 Docker rootless 镜像用作 shell 环境，不启动 `dockerd` 或 DinD 服务。它通过 `HOSTED_DOCKER_MIRROR` 获取官方 `moby/buildkit` 镜像中按 SHA-256 固定的层，校验归档后，仅提取 BuildKit 二进制和上游 daemonless 脚本，再以镜像中的非 root 用户运行 BuildKit。启动脚本显式将 `USER` 设为该账号，并在构建上下文之外分配私有的 `XDG_DATA_HOME` 和 `XDG_RUNTIME_DIR` 目录。工具和运行文件在退出时清理；BuildKit 状态可能含映射后的用户 ID，由任务容器销毁时回收。任务先检查命名空间和构建支持，再构建应用。

`HOSTED_DOCKER_MIRROR` 默认为 `docker-mirror.sh.synyi.com`。两个 CI 任务的镜像，以及 BuildKit 对 Docker Hub 的解析，都使用该拉取代理，包括 Dockerfile 前端与基础镜像。临时 BuildKit 配置位于 Docker 构建上下文之外，任务结束时清理。

保护计划采用的默认分支。[镜像构建脚本](../../../deploy/hosted-workspaces/ci-image.sh)将构建元数据保留为 GitLab 任务产物；镜像留在任务的临时 BuildKit 存储中。此过程无需 Registry、公司 SSO 或模型凭据。部署所需的镜像分发须另行选定目标，并满足项目的访问权限要求。

-----

<a id="sso-registration"></a>
## 注册公司 SSO 应用

请公司身份管理员提供独立的 OIDC 应用及其支持的流程。默认 `authorization-code` 模式在服务端交换授权码。若提供方只支持现有 EMR 风格的 ID token 响应而不支持授权码交换，则选择 `implicit`；本次集成不要求公司启用授权码流程。复用其登录体验，同时保持本应用与 EMR 使用不同的客户端注册。本地 mock 试用不需要公司应用注册。

| 设置 | `authorization-code`（默认） | `implicit` 兼容模式 |
|---|---|---|
| 应用类型 | 服务端 Web 客户端；分配密钥时使用机密客户端 | 允许 ID token 响应的 OIDC 客户端 |
| Client ID | 管理员分配的准确值，例如 `dsh-workspaces` | 管理员分配的准确值，例如 `dsh-workspaces` |
| 授权／响应类型 | `authorization_code` / `code` | `implicit` / `id_token`；不返回 access token |
| 响应模式 | 回调 GET 的查询参数 | 回调页面的 URL fragment |
| PKCE、state 和 nonce | `S256` PKCE、绑定浏览器的 state，以及 nonce | 绑定浏览器的 state 和 nonce；不使用 code verifier |
| Token 端点认证 | 机密客户端使用 `client_secret_basic`；公开客户端不使用密钥 | 不交换 token 端点，不使用客户端密钥 |
| Scope | `openid profile` | `openid profile` |
| 本地回调 | `http://chat.localhost:8080/auth/callback`，仅在公司策略允许本地 HTTP 测试时使用 | `http://chat.localhost:8080/auth/callback`，仅在公司策略允许本地 HTTP 测试时使用 |
| 公司回调 | 选定的入口 origin 后加 `/auth/callback`；准确注册协议、主机、端口和路径 | 选定的入口 origin 后加 `/auth/callback`；准确注册协议、主机、端口和路径 |
| Issuer 与发现 | 准确的 issuer，以及匹配的发现元数据 | 准确的 issuer，以及匹配的发现元数据 |
| ID token 声明与签名 | 稳定的 `sub`、正确的 issuer／audience、RS256 签名、可访问的 JWKS | 稳定的 `sub`、正确的 issuer／audience、RS256 签名、可访问的 JWKS |
| 试用应用授权 | 管理员选择的测试用户或用户组 | 管理员选择的测试用户或用户组 |
| 浏览器 origin 白名单 | 公司控制台要求时填写入口 origin | 公司控制台要求时填写入口 origin |
| 提供方退出回调 | 当前实现不使用 | 当前实现不使用 |

例如入口为 `https://chat.example.com` 时，回调必须是 `https://chat.example.com/auth/callback`。不注册通配回调，也不为每个个人子域名单独注册回调：所有 OIDC 回调都到达入口，再由网关完成个人 origin 交接。

管理员提供 issuer、client ID、支持的流程和可访问的 JWKS；授权码机密客户端还需要通过获准的密钥通道提供客户端密钥。`name` 或 `preferred_username` 用作显示名称，不能选择账号或运行实例。两种模式下，网关均验证 ID token 签名、issuer、audience、有效期、nonce，以及绑定浏览器的一次性 state。

implicit 模式的回调页面从地址栏移除 fragment，再通过同源 POST 将其中的字段提交给网关。网关通过提供方的 JWKS 验证 token 后，才创建浏览器会话；浏览器解码但未经验证的 token 不能用于认证。DSH 仅请求用于识别身份的 ID token，不请求 EMR 业务 access token 或 refresh token。不使用密码授权，也不将 SSO token 保存到 localStorage。浏览器不调用 token 端点，因此不需要 token 端点 CORS。

**退出仅影响本应用。** 它撤销浏览器会话并关闭对应连接。个人文件和后台任务会保留，公司的全局 SSO 会话仍有效。因此，后续公司账号登录可能无需再次输入密码。

-----

<a id="company-services"></a>
## 连接公司服务

在明确服务器和 TLS 入口后选择入口 origin。公司组合不使用 mock 覆盖配置。网关需要访问 SSO 发现和 JWKS 端点、已配置的模型上游，以及 Docker。授权码模式还需要 token 端点；implicit 模式不使用它。

参考[环境变量示例](../../../deploy/hosted-workspaces/.env.example)设置非密钥配置。将密钥路径指向 checkout 之外已有且访问受限的文件。Compose 仅将这些文件挂载到网关；个人容器获得独立、受限制的模型凭据。

```dotenv
HOSTED_PUBLIC_ORIGIN=https://chat.example.com
HOSTED_ALLOW_HTTP=false
HOSTED_OIDC_ISSUER=https://sso.example.com
HOSTED_OIDC_CLIENT_ID=dsh-workspaces
HOSTED_OIDC_FLOW=authorization-code
HOSTED_OIDC_CLIENT_SECRET_PATH=/srv/dsh-secrets/oidc_client_secret
HOSTED_DEEPSEEK_KEY_PATH=/srv/dsh-secrets/deepseek_api_key
```

implicit 应用设置 `HOSTED_OIDC_FLOW=implicit`。此模式不读取 `clientSecretFile`。基础 Compose 文件保留默认授权码流程的密钥挂载；不提供客户端密钥文件时，须在公司组合中同时移除网关挂载的 `oidc_client_secret` 及其顶层 secret 定义。DeepSeek 密钥仍仅挂载到网关。

这些值是需要替换的示例，不是既有公司部署。已配置的 issuer 可以直接访问时，`HOSTED_OIDC_DISCOVERY_URL` 可省略；若使用内部 URL，其元数据仍须返回该 issuer。密钥值不得写入 `.env`、命令参数、浏览器设置或已提交文件。

默认上游为 `https://api.deepseek.com/anthropic`；配置的模型 ID 是 `deepseek-flash` 和 `deepseek-v4-pro`。共享 Key 代理仅允许流式 `POST /model/v1/messages`，并限制每账号请求和输出。它拒绝 Files API 操作和上游文件引用。图片附件需要单独确认 DSH 内联回退的端到端流程。

公司入口需要为入口及 `*.portal-hostname` 配置 DNS，并提供覆盖这些名称的 TLS 证书。反向代理须保留 Host，将 HTTP 和 WebSocket 流量转发到网关。个人运行实例端口不对外发布；浏览器不直接连接运行实例容器。底层 Web 传输要求见[公开部署转发](public-deployments.zh.md)。

-----

<a id="isolation-and-limits"></a>
## 隔离与运行限制

网关将经过验证的 issuer 和 subject 映射为稳定账号，再选择该账号的容器和数据卷。会话用于另一账号的个人 origin 时会被拒绝。HTTP API、上传／下载和 WebSocket 升级均经过同一认证入口；浏览器提供的用户 ID、运行实例地址及转发请求头不能选择目标。

每个个人运行实例拥有自己的 home 数据卷和桥接网络。home 保存 DSH 数据、设置、已安装插件、文件和工作区状态。容器以 UID/GID `1000:1000` 运行，使用只读镜像、移除的 capabilities、`no-new-privileges` 和限制大小的 `/tmp`。仅网关挂载 Docker socket 和上游密钥文件。

每个容器默认限制为 2 GiB 内存、2 CPU、256 PID 和 256 MiB 临时存储。默认还限制最多 20 个注册账号，以及每账号每分钟 30 次共享 Key 模型请求、2 个并发请求。[包参考](../../../packages/experimental/hosted-workspaces/README.zh.md#configuration)链接到权威配置，并描述其他限制。

**当前实现没有持久磁盘硬配额。** 命名卷区分数据归属，但不能阻止某个账号写满宿主机磁盘。Linux 共享使用前，须根据实际 Docker 存储后端配置并验证文件系统／项目配额，或其他强制存储限制。备份、磁盘写满恢复、保留策略及网络／防火墙验证均属于该部署的验收。

退出登录不会终止账号的后台任务或容器。资源限制和模型准入仍然生效。此试用不提供自动空闲停止、多网关协调、医院／科室授权或患者系统集成。

-----

<a id="verification-and-recovery"></a>
## 验证与恢复

本地试用使用合成数据。通过浏览器入口执行下列场景并检查实际结果；单元检查不能代替部署验收。

| 场景 | 必须观察到的结果 |
|---|---|
| Alice 和 Bob 聊天并写入不同标记文件 | 各账号只能看到自己的聊天、文件、设置和工具输出 |
| Alice 在 Bob 的个人主机上使用自己的会话，或提供 Bob 的标识 | 网关拒绝请求；Bob 的运行实例不收到操作 |
| 每个账号均有待审批、终端或 subagent 活动 | 回答和流保留在所属运行实例内 |
| Alice 在 WebSocket 或流式响应尚未关闭时退出 | Alice 的会话失去访问权，对应连接关闭；Bob 继续连接 |
| 浏览器会话到期 | 新请求被拒绝，过期会话的流关闭 |
| 网关或个人运行实例重启 | 正确账号恢复自己的历史和文件；其他账号不能认领 |
| 工具检查环境变量及可读文件 | 不出现真实上游模型 Key；只能获得该运行实例受限制的凭据 |
| 运行实例测试网络和 Docker 访问 | 无法访问其他个人运行实例或 Docker 控制 socket |
| implicit 回调中的 ID token 被伪造、已到期、audience 不符或被重放 | 网关拒绝认证，不创建浏览器会话 |
| SSO、运行实例启动、模型上游或配额失败 | 操作明确失败，不选择其他账号，也不声称成功 |

入口不可用时，检查 Compose 服务状态和日志。登录失败时，检查准确回调、issuer、所配置的流程，以及 JWKS 是否可访问。授权码客户端还须检查 token 端点认证和已有的客户端密钥挂载。启动冲突或清理失败时，检查报告的 Docker 资源并保留数据卷；不得重命名其他用户的容器或绕过隔离检查来使启动成功。

mock 流程完成仅验证本地代码路径。公司验收仍需要已注册的真实 SSO 应用、真实 DeepSeek 流式请求、两个测试身份、计划采用的 Linux 网络／存储控制，以及独立用户验收。这不授权使用真实患者数据。

持久化卷和账号映射在容器重启后保留。更新镜像需要另行处理：完成或停止运行中的工作，备份网关和 home 数据卷，删除各旧个人容器时不加 `-v`，保留命名卷及相同资源前缀。下次通过认证的请求会使用配置的镜像重建容器。仅重启仍使用旧镜像；容器镜像与配置不符时，网关会拒绝访问。替换共享运行实例前，先用合成账号验证新镜像。

-----

<a id="further-exploration"></a>
## 进一步探索

- [Hosted-workspaces 包](../../../packages/experimental/hosted-workspaces/README.zh.md)——配置、保留的工作和实现归属。
- [个人工作区需求](../../requirements/sso-private-workspaces-v1.zh.md)——已约定范围及验收标准。
- [Web 应用](../../../packages/bundle/web-app/README.zh.md)——个人聊天和工具环境。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>验证工作上下文——点击展开</summary>

[需求验证记录](../../requirements/sso-private-workspaces-v1.zh.md#dev-note) 统一记录已执行的 Docker、浏览器、工具和模型检查。公司 SSO 注册、公司部署及独立用户验收均未执行。

</details>
