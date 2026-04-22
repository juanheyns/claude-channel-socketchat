---
layout: default
title: Getting started
---

# Getting started

## Prerequisites

- **Claude Code ≥ 2.1.80** with channels support
- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- **macOS or Linux** — Unix sockets are required
- **claude.ai account** — channels require OAuth, not API-key auth

## Install

### Recommended: via the marketplace

The fastest way to install socketchat is through the [`juanheyns-claude-plugins`](https://github.com/juanheyns/juanheyns-claude-plugins) marketplace. Inside Claude Code:

```
/plugin marketplace add juanheyns/juanheyns-claude-plugins
/plugin install socketchat@juanheyns-claude-plugins
```

Claude Code fetches the plugin, registers its MCP server, and activates it as a channel. The socket binds at `~/.claude/channels/socketchat/sessions/<instance-id>.sock` on first session.

To use the companion CLI (`socketchat`) for `ls`, `ping`, `send`, `chat`, and `log`, clone this repo separately:

```bash
git clone https://github.com/juanheyns/claude-channel-socketchat socketchat
cd socketchat
bun install     # for the client's deps
```

The CLI reads `~/.claude/channels/socketchat/index.json` to find running plugins — it works against whatever socketchat instances are active, regardless of whether you installed the plugin via marketplace or locally.

### For plugin development: `--plugin-dir`

If you're iterating on the plugin code itself, bypass the marketplace and load the local checkout directly:

```bash
git clone https://github.com/juanheyns/claude-channel-socketchat socketchat
cd socketchat
bun install
claude --plugin-dir "$PWD"
```

Claude Code reads `.claude-plugin/plugin.json` and `.mcp.json` from the plugin root and spawns the server from your local copy. Any changes to `server.ts` are picked up on next Claude start (or run `/reload-plugins`).

### Manual MCP registration (escape hatch)

Skip the plugin manifest entirely and register the server by hand:

```bash
claude mcp add socketchat bun "$PWD/server.ts"
claude --dangerously-load-development-channels server:socketchat
```

Works, but you lose the plugin niceties (versioning, keyword discovery, marketplace update flow). Use only for quick one-off testing.

## Start Claude with the channel loaded

Channels are currently a Claude Code research preview. You have to opt in explicitly at launch, and which flag to use depends on your account tier.

### Team/Enterprise (recommended for unattended work)

If your org admin has added socketchat to `allowedChannelPlugins` in managed settings (see [Deployment](deployment#enterprise-setup-no-confirmation-dialog) for the exact JSON), just launch with:

```bash
claude --channels plugin:socketchat@juanheyns-claude-plugins
```

No dialog. Suitable for `claude -p` and CI.

### Pro/Max (or before your org whitelists socketchat)

Use the development-channels flag. Claude Code shows an interactive confirmation dialog on launch — approve to continue:

```bash
claude --dangerously-load-development-channels plugin:socketchat@juanheyns-claude-plugins
```

The dialog blocks fully-unattended use of `claude -p`. Workarounds: supervise the first launch, or get socketchat into your org's `allowedChannelPlugins` list.

### After launch

Either way, on successful startup Claude Code spawns the plugin's MCP subprocess, which binds a Unix socket at `~/.claude/channels/socketchat/sessions/<instance-id>.sock`. Verify by running `socketchat ls` in another terminal — a session should appear.

## Install the client helper

The companion CLI lives inside the installed plugin at:

```
~/.claude/plugins/cache/juanheyns-claude-plugins/socketchat/<version>/client.ts
```

Add this function to your shell config (`~/.zshrc`, `~/.bashrc`, etc.) once:

```bash
socketchat() {
  local dir=$(ls -d ~/.claude/plugins/cache/juanheyns-claude-plugins/socketchat/*/ | sort -V | tail -1)
  bun "${dir}client.ts" "$@"
}
```

Reopen your shell. The function picks the highest installed version automatically. All examples below use `socketchat <cmd>`; substitute `bun ~/.claude/plugins/cache/.../*/client.ts <cmd>` if you'd rather not alias.

## First round-trip

List active sessions:

```bash
socketchat ls
# 7c9f2a43-...   2s   pid=12345   cwd=/Users/you/some/repo
```

You should see one entry with the session's instance id, pid, and cwd.

Ping the server (server-only, doesn't reach Claude):

```bash
socketchat ping
# pong from <id> (3ms)
```

Send a message (this one does reach Claude):

```bash
socketchat send '{"hello":"world"}'
```

The agent sees a `<channel source="socketchat" ...>` event in its context. Tell it in chat:

> "When you see a channel message, call the `reply` tool with the message_id as `reply_to` and echo the body."

Send again. This time the client prints the reply text back.

## Interactive mode

For back-and-forth exploration:

```bash
socketchat chat
```

Each line you type must be valid JSON. Responses (acks, replies) print with a `<` prefix.

## Pin the instance id

Pass `SOCKET_CHAT_INSTANCE_ID` in the shell env to get a predictable socket path. Examples below use `--channels` (the org-approved flag); substitute `--dangerously-load-development-channels` if you're on Pro/Max:

```bash
SOCKET_CHAT_INSTANCE_ID=$(uuidgen) \
  claude --channels plugin:socketchat@juanheyns-claude-plugins
```

Now the socket is at `~/.claude/channels/socketchat/sessions/<UUID>.sock`.

For full id unification, use the **same UUID** for `SOCKET_CHAT_INSTANCE_ID` and Claude's `--session-id`:

```bash
ID=$(uuidgen)
SOCKET_CHAT_INSTANCE_ID=$ID \
  claude --session-id "$ID" \
    --channels plugin:socketchat@juanheyns-claude-plugins
```

> **Important**: Claude Code's `--session-id` requires a valid UUID (e.g. `7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88`), not an arbitrary string. `SOCKET_CHAT_INSTANCE_ID` accepts `[A-Za-z0-9._-]` up to 128 chars, so a UUID works for both. `uuidgen` is available on macOS and most Linux distros.

See [deployment](deployment) for why you'd do this.

## Next

- [Architecture](architecture) — what's happening under the hood
- [Wire protocol](protocol) — message schemas and routing
- [CLI reference](cli) — all the `socketchat` subcommands
