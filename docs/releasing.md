---
layout: default
title: Releasing
---

# Releasing

socketchat releases propagate to the `juanheyns-claude-plugins` marketplace automatically via GitHub Actions. Tag a release in this repo; the marketplace entry updates itself.

## One-time setup

Required once per maintainer / repo fork.

### 1. Create a fine-grained PAT

Go to GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.

- **Token name**: `socketchat → marketplace sync`
- **Resource owner**: your user or org
- **Repository access**: **Only select repositories** → choose `juanheyns-claude-plugins`
- **Repository permissions**:
  - **Contents**: Read and write
  - **Metadata**: Read (auto-selected)
- **Expiration**: whatever you're comfortable rotating (90 days is common)

Copy the token when generated — it's shown only once.

### 2. Add the secret to the socketchat repo

In socketchat's GitHub page: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

- **Name**: `MARKETPLACE_SYNC_TOKEN`
- **Value**: paste the PAT

### 3. Verify

Push the workflow (if not already pushed). From the Actions tab, the workflow appears as "Publish to marketplace". It won't run yet — it triggers on tag push.

## Releasing a new version

Assuming you want to release `0.1.0`:

```bash
# 1. Bump the version in the plugin manifest
jq '.version = "0.1.0"' .claude-plugin/plugin.json > tmp && mv tmp .claude-plugin/plugin.json

# 2. (Optional) bump package.json too for consistency
jq '.version = "0.1.0"' package.json > tmp && mv tmp package.json

# 3. Commit
git add .claude-plugin/plugin.json package.json
git commit -m "Release 0.1.0"

# 4. Tag and push
git tag v0.1.0
git push origin main --tags
```

The `push` of the tag triggers the **Publish to marketplace** workflow. It:

1. Checks out socketchat at the tag
2. Verifies the tag (`v0.1.0`) matches `plugin.json` version (`0.1.0`). If mismatched, it fails loudly — fix the version in `plugin.json` and re-tag.
3. Clones `juanheyns-claude-plugins` using the PAT
4. Updates the socketchat entry in `marketplace.json`:
   - `plugins[].version = "0.1.0"`
   - `plugins[].source.ref = "v0.1.0"`
5. Commits and pushes

After it completes, users get the new version on their next `/plugin marketplace update`.

## Manual trigger

If you need to re-sync (e.g. the workflow failed and you fixed something), go to the Actions tab, pick "Publish to marketplace", click **Run workflow**, and enter the tag to sync.

## What the automation does NOT do

- **Bump the version for you** — you edit `plugin.json` and tag manually
- **Generate a CHANGELOG** — add one yourself if you want
- **Create a GitHub release** — the tag is pushed but no release object is created. Add `softprops/action-gh-release` to the workflow if you want that.
- **Publish to npm** — socketchat is distributed via the plugin marketplace, not npm

## Troubleshooting

### Workflow fails with "Tag v0.1.0 does not match plugin.json version X"

You tagged before bumping `plugin.json`. Either:

- Delete the tag, bump plugin.json, re-tag:
  ```bash
  git tag -d v0.1.0
  git push origin :refs/tags/v0.1.0
  # bump plugin.json, commit
  git tag v0.1.0
  git push origin v0.1.0
  ```
- Or bump plugin.json, push the commit, and re-point the tag:
  ```bash
  # bump plugin.json, commit
  git tag -f v0.1.0
  git push origin main -f refs/tags/v0.1.0
  ```

Then manually re-run the workflow with the tag.

### Workflow fails with 403 / permission denied pushing to marketplace

The PAT doesn't have access. Check:

- Token hasn't expired
- Repository access includes `juanheyns-claude-plugins`
- Contents permission is **Read and write**
- Secret name in the socketchat repo is exactly `MARKETPLACE_SYNC_TOKEN`

### Workflow succeeds but users don't see the new version

They need to refresh their local copy:

```
/plugin marketplace update juanheyns-claude-plugins
```

Or Claude Code auto-refreshes on startup if auto-update is enabled.
