---
description: "Web 主机的 OpenID Connect 登录闸门：带 PKCE 的授权码流程、邮箱/域名/主体白名单，以及 Connection 用以替代进程启动令牌的签名浏览器会话 Cookie。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-oauth

[English](README.md) | 中文

## 概述

通过 OpenID Connect 提供方登录 Web GUI，而不必共享 `dsh web` 启动令牌。该闸门提供 `/auth/login`、`/auth/callback`、`/auth/logout` 和 `/auth/session`，只允许邮箱、域名或主体白名单中的身份，并签发与请求 authority 绑定的 `HttpOnly` 会话 Cookie。Connection 像接受自己的签名浏览器 Cookie 一样接受它，因此浏览器、`/api` 信任栅栏和 WebSocket 升级都无需令牌即可认证。公开 URL 和 `--trusted-host` 仍然适用；该闸门只是身份层，不替代传输信任。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

通过 `--oauth-*` 参数族在 `dsh web` 中启用登录。提供方必须在 `<issuer>/.well-known/openid-configuration` 暴露 OpenID Connect 发现文档，其客户端注册必须精确列出回调 URL。

```sh
dsh --profile web \
  --public-url https://dsh.example/ \
  --trusted-host dsh.example \
  --oauth-issuer https://kc.example/realms/main \
  --oauth-client-id dsh \
  --oauth-client-secret-ref DSH_OAUTH_CLIENT_SECRET \
  --oauth-allow-domain example.com
```

配置了公开 URL 时，回调为 `<public-url>/auth/callback`（包含挂载前缀）；否则由请求 authority 和 `X-Forwarded-Proto` 推导。`--oauth-client-secret-ref` 指向环境变量或已存凭据引用；公共 PKCE 客户端可省略。`--oauth-allow-email`、`--oauth-allow-domain`、`--oauth-allow-subject` 至少要有一个；任何 `--oauth-*` 参数缺少 `--oauth-issuer` 和 `--oauth-client-id` 都是用法错误。

### 配置

```yaml
- name: '@deepseek-ai/dsh-host-oauth'
  config:
    issuer: https://kc.example/realms/main
    clientId: dsh
    clientSecretRef: DSH_OAUTH_CLIENT_SECRET
    allowedEmails: [operator@example.com]
    allowedDomains: [example.com]
    allowedSubjects: []
    sessionMaxAgeDays: 30
    publicUrl: https://dsh.example/
```

所有字段都可在 `cordis.yml` 中修改；默认值为 `scopes: [openid, email, profile]`、`cookieName: dsh-oauth`、`loginPath: /auth/login`、`callbackPath: /auth/callback`、`logoutPath: /auth/logout`、`sessionPath: /auth/session`、`sessionMaxAgeDays: 30` 和 `requestTimeoutMs: 10000`。

### 闸门强制执行的内容

- 授权请求使用授权码、PKCE S256、新 nonce，以及服务端保存并在短期 `HttpOnly; SameSite=Lax` Cookie 中镜像的一次性 state。
- 回调要求 state Cookie、待处理 state 和相同请求 authority。失败或重放的回调返回 400，且不会再消费另一个 state。
- ID 令牌会依据提供方 JWKS 校验签发者、受众、签名和 nonce。提供方未返回 ID 令牌时，由 UserInfo 端点用访问令牌提供声明。
- 标记为未验证的邮箱永远不会获得授权。邮箱和域名匹配不区分大小写；域名是精确匹配，不做后缀匹配。
- 每次请求都会重新读取白名单，因此删除条目后，即使 Cookie 尚未过期，下一次请求也会被撤销。
- 会话 Cookie 与请求 authority 绑定，使用凭据提供方保存的密钥签名，绝不会在不同主机或端口下被接受。
- `/auth/logout` 只清除本地会话，不结束提供方自身的 SSO 会话。
- 挂载闸门期间进程启动令牌被注销，因此共享的 `dsh web` URL 无法绕过提供方。

<a id="understand-the-implementation"></a>
## Understand the implementation

闸门由三个模块组成。`session.ts` 负责凭据支持的签名密钥、authority 绑定 Cookie 和 Cookie 序列化。`oidc.ts` 负责发现缓存、授权 URL、授权码兑换和声明提取。`index.ts` 负责路由、待处理授权表、重定向校验和 Connection 认证器。

`HostConnectionService.registerBrowserAuthenticator` 是接缝：Connection 检查每个已注册认证器，最后让其中一个接管未认证的索引响应。该闸门把浏览器索引请求重定向到 `<loginPath>?rd=<原始路径>`。挂载闸门时还会调用 `HostConnectionService.retireLaunchToken`：打印的 URL 不再携带令牌，`?token=` 请求不再签发 cookie，早先由令牌签发的 cookie 也不再被接纳；因此过期的带令牌 URL 会落到登录重定向，而不是让任何人登录。释放该插件会重新接纳启动令牌。

签名密钥是每个 Harness home 创建一次的 `host-oauth/session` grant 记录。待处理授权在内存中保留十分钟，最多 256 条；进程重启会丢弃进行中的登录，但已建立的会话仍有效。

### 源文件映射

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、路由、待处理 state、重定向安全、Connection 认证器 |
| [`src/oidc.ts`](src/oidc.ts) | 发现缓存、PKCE 授权 URL、令牌兑换、JWKS 校验 |
| [`src/session.ts`](src/session.ts) | 持久签名密钥、签名的 authority 绑定 Cookie、Cookie 序列化 |
| [`src/whitelist.ts`](src/whitelist.ts) | 邮箱、域名和主体的规范化与匹配 |
| [`tests/oauth.host.spec.ts`](tests/oauth.host.spec.ts) | 真实 HTTP 主机加伪造提供方：登录、白名单拒绝、回调失败 |
| [`tests/oidc.spec.ts`](tests/oidc.spec.ts) | 发现、兑换、nonce 和提供方失败路径 |
| [`tests/session.spec.ts`](tests/session.spec.ts) | Cookie 签发、篡改、过期和密钥记录 |

<a id="further-exploration"></a>
## Further Exploration

- [公开部署](../../../docs/user/guide/public-deployments.zh.md) — 该闸门周围的逆向代理必须提供什么。
- [client-connection](../../client/connection/README.zh.md) — 启动令牌交换、`/api` 信任栅栏和浏览器认证器接缝。
- [Web bundle](../../bundle/web-app/README.zh.md) — `dsh web` 如何挂载该行并打印启动 URL。

<a id="model-experience"></a>
## Model Experience

None, as the sign-in gate authenticates browser requests before they reach any model-facing route and registers no prompt, tool, or context contribution.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **没有提供方侧登出** — `/auth/logout` 只清除本地会话。结束提供方的 SSO 会话需要 `end_session_endpoint` 和 ID 令牌提示，闸门目前不请求它们。
- **待处理授权仅限进程内** — 重启或第二个 Host 进程会丢弃进行中的登录。已建立的 Cookie 仍然有效，因为其密钥是持久的。
- **`X-Forwarded-Proto` 被信任** — 回调 URL 和 Cookie 的 `Secure` 标志遵循第一个转发值。部署必须在受控代理处终止 TLS，并限制监听端口只对该代理开放。
- **仅白名单** — 除主体、邮箱、验证状态和显示名之外的提供方角色、组和声明不是授权输入。

<a id="dev-note"></a>
### 开发备注

闸门有意不签发 Connection 的 `dsh-auth-…` Cookie。它通过文档化的认证器接缝注册第二个凭据，使启动令牌行为、Cookie 生命周期和 `/api` 栅栏仍由一个包负责。
