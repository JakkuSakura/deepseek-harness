# Local plugins

Not part of DSH. These are local bundles, carried in this fork so the machine that runs
them has one place to find them, and so the patches they replace can be read next to the
code they change.

| plugin | what it is |
|---|---|
| `dsh-plugin-git-tree` | Workspace file tree with git change statistics, as a right-sidebar panel. Also the home of the runtime patch harness in its `patches/` directory, which applies the same fixes to an *installed* DSH — the fork carries them as source instead. |
| `dsh-plugin-push` | Web Push notifications: a VAPID identity, a subscription store, a service worker and a web-app manifest, so a browser can be told when a Session finishes, fails or is waiting. |
| `dsh-plugin-telegram` | Telegram → DSH over long polling. An allowed message becomes a Workspace-backed Session; polling means nothing has to be reachable from the internet. |

Each is a duplicate of its authoring checkout in `SakuraLens`. Divergence is the cost of
having them in both places; these are for reading and for the fork, and the runtime ones are
what a profile links to.

## What these replace

The authoring checkouts also carry a `patches/` harness, which applies five fixes to the
**built** files of an installed DSH — a pill's number, a command's grammar, a projection's
window, a goal editor, a resume button. Those are the five things this fork carries as
source commits on `sakura/local-patches`, so the same behaviour does not depend on editing
build output after every install.
