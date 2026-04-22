---
layout: default
title: Deployment
---

# Deployment

socketchat was designed for **unattended Claude Code running in ephemeral containers**. It's also useful for interactive dev work. This page covers both patterns.

## Ephemeral container pattern

Your orchestrator spins up a container, runs `claude -p` in a resumable loop, and reaps the container when done. Claude's state (transcript, memory) needs to survive container rotation. socketchat gives you a stable channel for pausing, signalling, and delivering approvals.

### Id unification

Choose one id per task and apply it consistently:

```bash
ID=task-42

SOCKET_CHAT_INSTANCE_ID=$ID \
  claude --session-id "$ID" \
    --dangerously-load-development-channels server:socketchat \
    -p "run the thing"
```

That single id becomes:

- Claude's transcript: `~/.claude/projects/<cwd-key>/$ID.jsonl`
- Plugin socket: `~/.claude/channels/socketchat/sessions/$ID.sock`
- Plugin log: `~/.claude/channels/socketchat/logs/$ID.log`
- Index entry `id`

Your orchestrator needs to track only `$ID` and the cwd. Socket path is deterministic; no index lookup needed.

**Caveat:** the alignment only holds for the **first** Claude session. Any in-process session switch (`/clear`, etc.) breaks it — the plugin id stays fixed while Claude's session id changes. For headless `claude -p` invocations, this doesn't matter because there are no in-process switches.

### Persistence across container rotation

State to carry between containers:

| Path | Purpose |
|---|---|
| `<cwd>` | Repo/workspace Claude was editing |
| `~/.claude/projects/<cwd-key>/` | Transcripts + Claude's auto-memory |
| Auth (`ANTHROPIC_API_KEY` env **or** `~/.claude/.credentials.json`) | Required to reattach to Claude |
| `~/.claude/channels/socketchat/` | _Optional._ Logs are useful post-mortem; sockets are ephemeral by nature — they live in a tmpfs volume and don't need to persist. |

On container start, the plugin's state directory is regenerated from scratch. Stale entries from before (if the volume did persist) are swept via the lockfile check.

### Shutdown protocol

When the container is about to go down, your orchestrator signals the agent:

```bash
# Orchestrator's shutdown hook
./client.ts send "$ID" '{"type":"shutdown","deadline":"'"$(date -u +%FT%TZ -d '+30 seconds')"'","note":"container rotation"}' \
  --timeout 25
```

Teach the agent how to react in project `CLAUDE.md`:

```markdown
## Shutdown protocol
When you see `{"type":"shutdown",...}` on the channel:
1. Abandon any current tool call that can't finish cleanly
2. `git add -A && git commit -m "wip: auto-checkpoint"` on a `wip/` branch
3. Write a project memory titled "resume-point" with: task state, next step, blockers
4. Reply through the channel: `{"acknowledged": true, "checkpoint_branch": "wip/<name>"}`
5. Stop. Do not start new work.
```

Next container resumes with `--session-id $ID`; the agent reads `CLAUDE.md` + the resume-point memory and picks up coherently.

### Approval requests (auth gate)

The agent asks for permission via a blocking tool. Your approval UI (Slack bot, web form, whatever) POSTs the human's decision to a socketchat connection. The flow:

1. Agent invokes `request_authorization(action)` — an MCP tool you define separately, NOT via socketchat
2. That tool POSTs to your approval system and waits for the human
3. Your approval system delivers the answer back by opening a socketchat connection and sending `{"request_id":"...","approved":true,"approver":"juan"}`
4. The agent sees the channel message, correlates by `request_id`, proceeds

Alternatively, the agent can listen passively for approval messages and take no action until one arrives — simpler, less ceremony.

## Interactive / dev pattern

For interactive use the setup is the same, but the channel typically serves:

- A deploy gate that needs your OK
- A sidecar pushing status updates
- An ops script signalling "wrap up, you've been at this for 20 minutes"

The id doesn't need to be pinned — a random UUID is fine. Discover running sessions with `client.ts ls` and target by cwd substring:

```bash
./client.ts send repo-a '{"event":"deploy-queued"}'
```

## Packaging for distribution

socketchat ships both as a raw directory and as a proper Claude Code plugin, so there are three distribution surfaces — pick whichever matches your users' workflow.

### Level 1 — `--plugin-dir` against a local checkout

For dev, or a single-host one-off:

```bash
git clone https://github.com/juanheyns/claude-channel-socketchat socketchat
cd socketchat
bun install
claude --plugin-dir "$PWD"
```

No marketplace needed; the `.claude-plugin/plugin.json` and `.mcp.json` are read directly from the checkout.

### Level 2 — the `juanheyns-claude-plugins` marketplace (current default)

This is how end users install. socketchat is listed in the [`juanheyns-claude-plugins`](https://github.com/juanheyns/juanheyns-claude-plugins) marketplace catalog. Users run:

```
/plugin marketplace add juanheyns/juanheyns-claude-plugins
/plugin install socketchat@juanheyns-claude-plugins
```

Versions are pinned via `source.ref` in the marketplace catalog. See [Releasing](releasing) for the automated publication flow — tag `v*` in this repo and GitHub Actions updates the marketplace automatically.

### Level 3 — official Anthropic marketplace

Submit via [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit). Anthropic's review process applies. Not currently done; the `juanheyns-claude-plugins` marketplace is the authoritative source.

## Docker / container image

A minimal image:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY server.ts client.ts ./

# Claude Code itself
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV SOCKET_CHAT_DIR=/run/socketchat
VOLUME /run/socketchat

# Override at runtime: SOCKET_CHAT_INSTANCE_ID, ANTHROPIC_API_KEY, --session-id, etc.
ENTRYPOINT ["claude", "--dangerously-load-development-channels", "server:socketchat"]
```

Mount `/run/socketchat` from a shared tmpfs so the orchestrator can reach the socket:

```bash
docker run --rm \
  -e SOCKET_CHAT_INSTANCE_ID=task-42 \
  -e ANTHROPIC_API_KEY=... \
  -v /tmp/socketchat-shared:/run/socketchat \
  my-claude-image
```

Then from the host, `./client.ts send task-42 '{...}'` (with `SOCKET_CHAT_DIR=/tmp/socketchat-shared`) reaches inside the container.

## CLAUDE.md snippet

A minimal stanza to drop into the project's `CLAUDE.md` so the agent knows how to use the channel:

```markdown
## Channel messages (socketchat)
Messages arrive as `<channel source="socketchat" ...>`. Each one requires a reply via the
`reply` tool, passing its `message_id` as `reply_to`. Replies route back to the exact
process that sent the message. If the reply tool returns `{"delivered":false,...}`, the
sender is gone; do not retry.

Message bodies are application-defined JSON. Look for these well-known types:
- `{"type":"shutdown",...}` — see shutdown protocol
- `{"type":"ping-from-ops"}` — respond with `{"ok":true}` to confirm liveness
```
