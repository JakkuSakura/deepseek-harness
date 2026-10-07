# dsh-plugin-telegram

Telegram → DSH. An allowed message becomes a **Workspace-backed Session**; the
harness's own webhook runtime creates it, so this plugin never picks a workspace,
a model or a session — it authenticates, translates, and hands over.

## Why polling

Messages arrive by **long polling**, so nothing has to be reachable from the
internet: no public URL, no certificate, no inbound port, no tunnel. It works behind
NAT and on a laptop, which is where this harness runs. Telegram is the only party
that has to be online.

## Install

Add the package to your profile and give it a row:

```yaml
- id: telegram
  name: "dsh-plugin-telegram"
  config:
    botTokenRef: TELEGRAM_BOT_TOKEN
    allowedChats: ["<your chat id>"]
    allowedUsers: ["<your user id>"]
    notifyChat: "<your chat id>"
```

`TELEGRAM_BOT_TOKEN` goes in `~/.zshenv` (or the credentials store) — a **reference**
is configured, never a value, so the token is resolved per operation and a rotation
needs no restart.

## The allow-list is the security boundary

**A Telegram message is a prompt that can run tools on this machine.** So:

- **Empty lists allow nobody.** A bot token leaks; a bridge that trusts whoever
  finds it is a remote shell.
- Both lists must agree: the chat *and* the user.
- A message that is refused is **logged**, because a message that silently does
  nothing is the hardest kind of allow-list mistake to notice.

## What comes next

- **Replies.** The runtime stamps each Session it creates with a `webhook` message
  source carrying the delivery id, so a Session's output can be routed back to the
  chat that asked for it.
- **Notices.** "Session finished" and "waiting for you" — the latter with an inline
  keyboard, so an agent that stops for input can be answered from a phone.
- **Webhook mode**, if the bridge should live on a server rather than a laptop.
