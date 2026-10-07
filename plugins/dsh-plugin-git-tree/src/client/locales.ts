/**
 * `gitTree` namespace dictionaries, and the namespace's declaration.
 *
 * Copy lives with its key set so any module naming `TranslateNS<'gitTree'>`
 * needs only this file. The failure lines name what the tree could not list, one
 * case each, because a directory that is gone, one outside the workspace, and a
 * path that is not a directory each suggest a different next step.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar panel label, its tab names, row states, and failure lines. */
    gitTree: GitTreeKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'panel.label': 'Git',
  'tab.sessions': '会话',
  'tab.worktree': '工作区',
  'tab.files': '文件',
  'session.new': '新会话',
  'session.rename': '重命名会话',
  'session.renamePlaceholder': '会话名称',
  'session.delete': '删除会话',
  'session.clone': '克隆会话',
  'session.actionFailed': '操作失败：{message}',
  'workspace.delete': '删除空工作区',
  'workspace.add': '添加工作区',
  'diff.loading': '正在读取更改…',
  'diff.unsupported': '此更改无法显示。',
  'diff.failed': '读取更改失败：{message}',
  'diff.stale': '刷新失败，以下为上次结果：{message}',
  'diff.empty': '此文件与上次提交相比没有变化。',
  'diff.truncated': '更改过多，仅显示前一部分。',
  'diff.untracked': '未跟踪',
  'diff.view.unified': '合并',
  'diff.view.split': '并排',
  'diff.view.compare': '对比',
  'diff.view.file': '整文件',
  'diff.view.before': '修改前',
  'diff.view.after': '修改后',
  'diff.view.whole': '完整',
  'diff.image.noPrevious': '此前无此文件',
  'diff.image.missing': '读不到这张图片',
  'tabs.closeAll': '关闭所有标签页',
  'worktree.submodule': '子模块',
  'stats.tokensPerSecond': '{value} tok/s',
  'session.status.running': '运行中',
  'session.status.input': '等待输入',
  'session.status.draft': '有未发送的输入',
  'session.status.unread': '有新结果',
  'sessions.empty': '还没有任何会话。',
  'sessions.emptyGroup': '这个工作区还没有会话。',
  binary: '二进制',
  'worktree.summary': '{count} 个变更',
  'worktree.empty': '工作区是干净的，没有未提交的变更。',
  'worktree.noRepository': '这个工作区不在 Git 仓库中。',
  'worktree.truncated': '变更太多，只显示了一部分。',
  'files.loading': '正在读取…',
  'files.empty': '空目录',
  'files.truncated': '条目太多，只显示了一部分。',
  'files.noWorkspace': '这个会话没有工作区目录。',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
} satisfies Record<string, string>

/** Git-tree dictionary key union. */
export type GitTreeKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'panel.label': 'Git',
  'tab.sessions': 'Sessions',
  'tab.worktree': 'Worktree',
  'tab.files': 'Files',
  'session.new': 'New Session',
  'session.rename': 'Rename session',
  'session.renamePlaceholder': 'Session name',
  'session.delete': 'Delete session',
  'session.clone': 'Clone session',
  'session.actionFailed': 'Failed: {message}',
  'workspace.delete': 'Delete empty workspace',
  'workspace.add': 'Add workspace',
  'diff.loading': 'Reading the change…',
  'diff.unsupported': 'This change cannot be shown.',
  'diff.failed': 'Could not read the change: {message}',
  'diff.stale': 'The refresh failed; this is the last good read: {message}',
  'diff.empty': 'This file does not differ from the last commit.',
  'diff.truncated': 'The change is larger than one read; only its start is shown.',
  'diff.untracked': 'untracked',
  'diff.view.unified': 'Unified',
  'diff.view.split': 'Split',
  'diff.view.compare': 'Diff',
  'diff.view.file': 'File',
  'diff.view.before': 'Before',
  'diff.view.after': 'After',
  'diff.view.whole': 'Whole',
  'diff.image.noPrevious': 'no earlier version',
  'diff.image.missing': 'this picture could not be read',
  'tabs.closeAll': 'Close all tabs',
  'worktree.submodule': 'submodule',
  'stats.tokensPerSecond': '{value} tok/s',
  'session.status.running': 'running',
  'session.status.input': 'waiting for you',
  'session.status.unread': 'has something new',
  'session.status.draft': 'unsent input',
  'sessions.empty': 'No sessions yet.',
  'sessions.emptyGroup': 'No sessions in this workspace yet.',
  binary: 'bin',
  'worktree.summary': '{count} changed',
  'worktree.empty': 'The working tree is clean.',
  'worktree.noRepository': 'This workspace is not inside a git repository.',
  'worktree.truncated': 'Too many changes, showing only some of them.',
  'files.loading': 'Reading…',
  'files.empty': 'Empty directory',
  'files.truncated': 'Too many entries, showing only some of them.',
  'files.noWorkspace': 'This session has no workspace directory.',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
} satisfies Record<GitTreeKey, string>
