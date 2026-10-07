# dsh-plugin-push

Web Push notifications for the DeepSeek Harness: tell a browser when a Session
finishes, fails, or is waiting on you.

## Why the Host half does the sending

A notification that only fires while a page is open is not a notification. On iOS
the web app is suspended when it is not in front, so **the server must be the one
that sends** — the browser's subscription is a capability handed to the Host, not a
channel the page keeps.

## Status

The Host half is built and tested; the browser half is not yet written.

- **Done:** the server's VAPID identity, the subscription store, the sender, and the
  routes. 17 tests, all against stubs — no browser, no key material, no network.
- **Next:** the projection fold that turns Session events into notifications, then
  the service worker, the web app manifest (an iOS prerequisite) and the client half
  that subscribes.

## Routes

All four sit under `/api`, which DSH's browser-trust fence guards. That is
deliberate: a browser that subscribes here receives Session titles, so subscribing
must not be something a stray client on the network can do. A test asserts the
placement rather than trusting it.

| route | method | what it does |
|---|---|---|
| `/api/push/key` | GET | the VAPID **public** key; the private half never leaves the process |
| `/api/push/subscribe` | POST | stores a subscription, keyed by endpoint |
| `/api/push/unsubscribe` | POST | forgets one |
| `/api/push/test` | POST | sends a real notification down the whole path |

`/api/push/test` is part of the product, not a debug hatch. It is how the pipeline —
key, subscription, push service, service worker — gets proved before any trigger
depends on it.

## Configuration

```yaml
- id: push
  name: "dsh-plugin-push"
  config:
    # Where the keys and subscriptions live. Defaults to $DSH_HOME/push.
    dataDir: ""
    # A mailto: or https:// contact, as VAPID requires.
    subject: "mailto:you@example.com"
```

## Two rules worth keeping

**Only a gone subscription is pruned.** A push service answers `404` or `410` when a
subscription will never work again; a rate limit or a bad minute answers otherwise.
Pruning on those would silently unsubscribe someone, so the classification is tested
directly.

**A failed delivery is logged.** A notification that never arrives is the failure
mode that makes people stop trusting the feature, so it is never swallowed.

## Notes

- The private key is written `0600` and atomically, because a half-written key file
  looks like an existing identity and would quietly break every subscription.
- `web-push` is CommonJS; inlined into an ESM bundle its `require("crypto")` has no
  home, so the build injects a real `require`. Without it the plugin throws on load.
