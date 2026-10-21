---
description: "OpenID Connect login gate for the Web host: authorization-code flow with PKCE, an email/domain/subject whitelist, and a signed browser session cookie that replaces the process launch token."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-oauth

English | [中文](README.zh.md)

## Summary

Sign users in to the Web GUI through an OpenID Connect provider instead of sharing the `dsh web` launch token. The gate serves `/auth/login`, `/auth/callback`, `/auth/logout`, and `/auth/session`, admits only identities named by an email, domain, or subject whitelist, and issues an authority-bound `HttpOnly` session cookie. Connection accepts that cookie for the index, the `/api` fence, and the WebSocket upgrade, and mounting the gate retires the launch token, so this sign-in is the only way in. A public URL and `--trusted-host` still apply; the gate is an identity layer, not a replacement for transport trust.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable sign-in from `dsh web` with the `--oauth-*` flag family. The provider must expose an OpenID Connect discovery document at `<issuer>/.well-known/openid-configuration`, and its client registration must list the callback URL exactly.

```sh
dsh --profile web \
  --public-url https://dsh.example/ \
  --trusted-host dsh.example \
  --oauth-issuer https://kc.example/realms/main \
  --oauth-client-id dsh \
  --oauth-client-secret-ref DSH_OAUTH_CLIENT_SECRET \
  --oauth-allow-domain example.com
```

With a public URL, the callback is `<public-url>/auth/callback` (including any mount prefix); without one it is derived from the request authority and `X-Forwarded-Proto`. `--oauth-client-secret-ref` names an environment variable or stored credential reference; omit it for a public PKCE client. At least one of `--oauth-allow-email`, `--oauth-allow-domain`, or `--oauth-allow-subject` is required, and any `--oauth-*` flag without `--oauth-issuer` and `--oauth-client-id` is a usage error.

### Configuration

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

Every field is changeable from `cordis.yml`; the defaults are `scopes: [openid, email, profile]`, `cookieName: dsh-oauth`, `loginPath: /auth/login`, `callbackPath: /auth/callback`, `logoutPath: /auth/logout`, `sessionPath: /auth/session`, `sessionMaxAgeDays: 30`, and `requestTimeoutMs: 10000`.

### What the gate enforces

- The authorization request uses authorization code, PKCE S256, a fresh nonce, and a single-use state held server-side and mirrored in a short-lived `HttpOnly; SameSite=Lax` cookie.
- The callback requires the state cookie, the pending state, and the same request authority. A failed or replayed callback answers 400 without consuming another state.
- The ID token is verified against the provider's JWKS for issuer, audience, signature, and nonce. When a provider returns no ID token, the UserInfo endpoint supplies claims over the access token.
- An email marked unverified never authorizes. Email and domain matches are case-insensitive; domain matching is exact, not suffix matching.
- The whitelist is re-read on every request, so removing an entry revokes the next request even when the cookie has not expired.
- The session cookie is bound to the request authority, signed with a secret stored in the credential provider, and never accepted under a different host or port.
- `/auth/logout` clears the local session; it does not end the provider's own SSO session.
- The process launch token is retired while the gate is mounted, so a shared `dsh web` URL cannot bypass the provider.

<a id="understand-the-implementation"></a>
## Understand the implementation

The gate is three modules. `session.ts` owns the credential-backed signing secret, the authority-bound cookie, and cookie serialization. `oidc.ts` owns discovery caching, the authorization URL, the code exchange, and claim extraction. `index.ts` owns routes, the pending-authorization table, redirect validation, and the Connection authenticator.

`HostConnectionService.registerBrowserAuthenticator` is the seam: Connection checks each registered authenticator and finally asks one to own the unauthenticated index response. This gate redirects a browser index request to `<loginPath>?rd=<original path>`. Mounting the gate also calls `HostConnectionService.retireLaunchToken`, which stops the printed URL carrying a token, stops a `?token=` request from minting a cookie, and stops cookies minted from an earlier token from admitting; a stale tokenized URL therefore lands on the sign-in redirect instead of logging anyone in. Disposing the plugin re-admits the launch token.

The signing secret is a `host-oauth/session` grant record created once per Harness home. Pending authorizations live in memory for ten minutes and are capped at 256 entries; a process restart drops in-flight sign-ins but leaves established sessions valid.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, routes, pending state, redirect safety, Connection authenticator |
| [`src/oidc.ts`](src/oidc.ts) | Discovery cache, PKCE authorization URL, token exchange, JWKS verification |
| [`src/session.ts`](src/session.ts) | Durable signing secret, signed authority-bound cookie, cookie serialization |
| [`src/whitelist.ts`](src/whitelist.ts) | Email, domain, and subject normalization and matching |
| [`tests/oauth.host.spec.ts`](tests/oauth.host.spec.ts) | Real HTTP host plus fake provider: sign-in, whitelist rejection, callback failures |
| [`tests/oidc.spec.ts`](tests/oidc.spec.ts) | Discovery, exchange, nonce, and provider failure paths |
| [`tests/session.spec.ts`](tests/session.spec.ts) | Cookie minting, tampering, expiry, and secret records |

<a id="further-exploration"></a>
## Further Exploration

- [Public deployments](../../../docs/user/guide/public-deployments.md) — what the reverse proxy must provide around this gate.
- [client-connection](../../client/connection/README.md) — launch-token exchange, the `/api` trust fence, and the browser authenticator seam.
- [Web bundle](../../bundle/web-app/README.md) — how `dsh web` mounts this row and prints the startup URL.

<a id="model-experience"></a>
## Model Experience

None, as the sign-in gate authenticates browser requests before they reach any model-facing route and registers no prompt, tool, or context contribution.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No provider-side logout** — `/auth/logout` clears the local session only. Ending the provider's SSO session needs an `end_session_endpoint` and an id-token hint, which the gate does not yet request.
- **Pending authorizations are process-local** — a restart or a second Host process drops in-flight sign-ins. Established cookies survive because their secret is durable.
- **`X-Forwarded-Proto` is trusted** — the callback URL and cookie `Secure` flag follow the first forwarded value. Deployments must terminate TLS at a proxy they control and restrict the listening port to it.
- **Whitelist only** — roles, groups, and provider claims beyond subject, email, verification, and display name are not authorization inputs.

<a id="dev-note"></a>
### Dev Note

The gate intentionally does not mint Connection's `dsh-auth-…` cookie. It registers a second credential through the documented authenticator seam, so launch-token behavior, cookie lifetimes, and the `/api` fence stay owned by one package.
