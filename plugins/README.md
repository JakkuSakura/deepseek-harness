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

## Vendoring

The git bundle is **authored in `SakuraLens/deepseek-harness-plugin`** and **vendored here**.
The copy in this directory is a mirror of that checkout, kept so the machines that run DSH
resolve the plugin from the fork rather than from a working copy:

```sh
rsync -a --delete --exclude node_modules --exclude .git \
  ~/Dev/SakuraLens/deepseek-harness-plugin/ ~/Dev/deepseek-harness/plugins/dsh-plugin-git-tree/
```

`--delete` is load-bearing: without it a module removed at the source survives here, which is
how this copy kept carrying a file the authoring checkout had already dropped. `node_modules`
is excluded so the installed dependencies are left alone — a `link:` target resolves its own.
