#!/bin/bash
# Vendor the SakuraLens authoring checkout into this fork.
#
# The git bundle is authored in `SakuraLens/deepseek-harness-plugin` and mirrored into
# `plugins/dsh-plugin-git-tree`, because the machines that run DSH resolve the plugin from
# the fork rather than from a working copy. This runs as the repository's `postinstall`, so
# a plain `pnpm install` refreshes the mirror.
#
# It is a **no-op** wherever the authoring checkout is not a real one. That matters more than
# it looks: jakku-mp4 has an old `SakuraLens` tree with stale, *untracked* copies of these
# plugins in it, and vendoring from those would quietly regress the fork. So the source must
# be a checkout that actually *tracks* the plugin, which an untracked copy is not.
#
# `--delete` is load-bearing: without it a module removed at the source survives here, which
# is how this copy once kept carrying a file the authoring checkout had already dropped.
# `node_modules` is excluded because a `link:` target resolves its own dependencies, and
# overwriting them from a source that may not have them would break the running install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTHORING="${DSH_PLUGIN_AUTHORING:-$HOME/Dev/SakuraLens}"
SOURCE="$AUTHORING/deepseek-harness-plugin"
TARGET="$ROOT/dsh-plugin-git-tree"

if [ ! -d "$SOURCE" ]; then
  echo "vendor: no authoring checkout at $SOURCE — leaving the vendored copy as it is"
  exit 0
fi

# A real authoring checkout tracks the plugin. An untracked copy (a stale tree on another
# machine) does not, and must never be a vendor source.
if ! git -C "$AUTHORING" ls-files --error-unmatch deepseek-harness-plugin >/dev/null 2>&1; then
  echo "vendor: $SOURCE is not tracked by its checkout — not a vendor source, skipping"
  exit 0
fi

if [ ! -d "$TARGET" ]; then
  echo "vendor: no vendored copy at $TARGET — skipping"
  exit 0
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude .git "$SOURCE/" "$TARGET/"
else
  # Without rsync, mirror with tar rather than an overlay: the deletions are the point. The
  # installed dependencies are not part of the source, so they are set aside and put back.
  KEEP="$TARGET.node_modules.keep"
  if [ -d "$TARGET/node_modules" ]; then mv "$TARGET/node_modules" "$KEEP"; fi
  rm -rf "$TARGET" && mkdir -p "$TARGET"
  tar -C "$SOURCE" --exclude node_modules --exclude .git -cf - . | tar -C "$TARGET" -xf -
  if [ -d "$KEEP" ]; then mv "$KEEP" "$TARGET/node_modules"; fi
fi

echo "vendor: mirrored $SOURCE into $TARGET"
