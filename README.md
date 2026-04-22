# socketchat

Unix-socket channel MCP plugin for Claude Code. External processes on the same host push messages into a running Claude session; the agent replies through the same socket. Filesystem permissions are the only auth — no tokens, no network config, no chat app.

## Why

Claude Code's [channels](https://code.claude.com/docs/en/channels.md) let external events reach a running session. The official channels (Telegram, Discord, iMessage) are chat-oriented and require bot credentials. For **host-local automation** — orchestrators, sidecars, cron jobs, approval UIs, deploy gates — Unix sockets are a better fit:

- Any local process with `chmod` access can send
- No tokens to rotate, no auth handshake
- Survives in ephemeral containers with a shared tmpfs
- Trivial to test from the shell (`nc -U`, `socketchat send`)

## What you get

- A Unix socket per Claude session at `~/.claude/channels/socketchat/sessions/<id>.sock`
- Bidirectional NDJSON: senders push JSON messages, Claude replies via the `reply` tool, routed back to the originating connection
- A discovery index (`~/.claude/channels/socketchat/index.json`) listing active sessions with cwd, pid, and socket path
- A structured JSON log per session for debugging
- A companion CLI (`socketchat`) with `ls`, `ping`, `send`, `chat`, and `log` subcommands

## Install

### For end users — via the `juanheyns-claude-plugins` marketplace

1. Add the marketplace and install the plugin. Inside Claude Code:

   ```
   /plugin marketplace add juanheyns/juanheyns-claude-plugins
   /plugin install socketchat@juanheyns-claude-plugins
   ```

2. Relaunch Claude with the channel explicitly loaded. Which flag depends on your account:

   **Team/Enterprise with socketchat on the org allowlist** (no dialog — recommended for unattended work):

   ```bash
   claude --channels plugin:socketchat@juanheyns-claude-plugins
   ```

   **Pro/Max or anyone not on an org allowlist** (interactive confirmation dialog on launch):

   ```bash
   claude --dangerously-load-development-channels plugin:socketchat@juanheyns-claude-plugins
   ```

   Channels are currently a research preview in Claude Code. The normal `--channels` flag only accepts plugins on either Anthropic's maintained allowlist or your organization's `allowedChannelPlugins` managed setting. socketchat is a third-party plugin, so Pro/Max users must use the `--dangerously-load-development-channels` form until an admin whitelists it.

   See [Deployment](docs/deployment.md) for the enterprise setup and unattended workflows.

3. From any shell, invoke the installed client:

   ```bash
   # Discover active sessions
   bun ~/.claude/plugins/cache/juanheyns-claude-plugins/socketchat/*/client.ts ls

   # Send a message
   bun ~/.claude/plugins/cache/juanheyns-claude-plugins/socketchat/*/client.ts send '{"hello":"from ops"}'
   ```

   The glob resolves to the currently-installed version dir. For convenience, add a shell function to your `~/.zshrc` / `~/.bashrc`:

   ```bash
   socketchat() {
     local dir=$(ls -d ~/.claude/plugins/cache/juanheyns-claude-plugins/socketchat/*/ | sort -V | tail -1)
     bun "${dir}client.ts" "$@"
   }
   ```

   Then just `socketchat ls`, `socketchat send '{}'`, etc.

### For development — `--plugin-dir`

```bash
git clone https://github.com/juanheyns/claude-channel-socketchat socketchat
cd socketchat
bun install
claude --plugin-dir "$PWD"
```

Claude Code picks up `.claude-plugin/plugin.json` and `.mcp.json` from the plugin root automatically. Use this path when iterating on the plugin itself. From here, `./client.ts ls` works directly (the repo's own copy).

See [`docs/`](./docs/) for the full picture, including deployment in ephemeral containers, the wire protocol, and a manual test plan.

## Requirements

- Claude Code ≥ 2.1.80 (channels support)
- [Bun](https://bun.sh) runtime
- macOS or Linux (Unix-socket-based)
- A claude.ai account (channels require OAuth, not API key auth)

## License

[MIT](./LICENSE)
