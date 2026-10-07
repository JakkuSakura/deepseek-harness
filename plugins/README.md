# Local plugins

Not part of DSH. These are local bundles, carried in this fork so the machine that runs
them has one place to find them, and so the changes they motivated can be read next to the
source they change.

| plugin | what it is |
|---|---|
| `dsh-plugin-git-tree` | Workspace file tree with git change statistics, as a right-sidebar panel. Also the home of the runtime patch harness in its `patches/` directory, which applies fixes to an *installed* DSH — this fork carries the ones still needed as source commits instead. |
| `dsh-plugin-push` | Web Push notifications: a VAPID identity, a subscription store, a service worker and a web-app manifest, so a browser can be told when a Session finishes, fails or is waiting. |
| `dsh-plugin-telegram` | Telegram → DSH over long polling. An allowed message becomes a Workspace-backed Session; polling means nothing has to be reachable from the internet. |

Each is a duplicate of its authoring checkout in `SakuraLens`. Divergence is the cost of
having them in both places; these are for reading and for the fork, and the runtime ones are
what a profile links to.
