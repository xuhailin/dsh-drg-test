---
kind: upgrade-guide
description: "hosted-workspaces 入口根路径通过 HTTP 303 发起 SSO，不再提供 HTTP 200 登录页面。"
---

# Hosted-workspaces 自动发起公司登录

[English](guide.md) | 中文

## 变更

hosted-workspaces 网关的未认证 `GET /` 返回指向公司 SSO 的 HTTP 303，不再提供需要点击登录的 HTTP 200 页面。有效会话继续进入自己的工作区。`GET /?signedout=1` 仍返回退出确认页，不自动恢复 SSO。

匿名个人 `/` 和 `/index.html` 请求经统一入口返回，不将旧 origin 携带为登录目标。新验证的身份决定个人工作区。跨账号 API 授权和显式目标校验仍然生效。

## 迁移

1. 更新预期入口返回 HTTP 200 页面或点击其登录操作的 HTTP 检查和浏览器自动化。跟随 HTTP 303 登录流程；使用 `GET /healthz` 检查网关存活，避免发起登录。
2. 将用户书签指向配置的 `publicOrigin`。旧个人首页书签经统一入口恢复，打开当前已认证账号的工作区。
3. 使用全新浏览器会话验证自动入口，使用有效会话验证恢复自己的工作区，并检查 `/?signedout=1` 保留退出确认。确认另一个账号的 API 请求仍被拒绝。参阅[试用与恢复指南](../../../user/guide/hosted-workspaces.zh.md#verification-and-recovery)。
