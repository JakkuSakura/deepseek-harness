# Local plugins

Not part of DSH. These are local bundles, carried in this fork so the machine that runs
them has one place to find them, and so the changes they motivated can be read next to the
source they change.

| plugin | what it is |
|---|---|
| `dsh-plugin-git-tree` | Workspace file tree with git change statistics, as a right-sidebar panel: the worktree switcher, the Files tree, the Changes view and its diff modes. Also the home of the runtime patch harness in its `patches/` directory, which applies fixes to an *installed* DSH — this fork carries the ones still needed as source commits instead. Authored in `SakuraLens/deepseek-harness-plugin`, and copied here; the profile on this machine links to the authoring copy. |
| `dsh-plugin-push` | Web Push notifications: a VAPID identity, a subscription store, a service worker and a web-app manifest, so a browser can be told when a Session finishes, fails or is waiting. Moved here from `SakuraLens`, which no longer carries it — this is its single source. |

The Telegram plugin was removed: it had never been configured, and it does not activate on
DSH 0.2.1, where it waits for a `webhookRuntime` service that version does not provide.
