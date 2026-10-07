# Local plugins

Not part of DSH. These are local bundles, carried in this fork so the machine that runs
them has one place to find them, and so the patches they replace can be read next to the
code they change.

| plugin | what it is |
|---|---|
| `dsh-plugin-git-tree` | Workspace file tree with git change statistics, as a right-sidebar panel. Also the home of the runtime patch harness in its `patches/` directory, which applies the same fixes to an *installed* DSH — the fork carries them as source instead. |

The copy here is a duplicate of the authoring checkout in `SakuraLens`. Divergence is
the cost of having it in both places; this one is for reading and for the fork, and the
runtime one is what a profile links to.
