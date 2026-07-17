# Setup

## Install

Prerequisites: Pi, Bun 1.3.14 or newer, Node.js, and Git. Node remains required for the permission-restricted workflow sandbox. Claude Code and Codex are optional subagent backends.

```sh
mkdir -p ~/projects
git clone https://github.com/demattosanthony/my-pi-setup.git ~/projects/my-pi-setup
cd ~/projects/my-pi-setup
bun install --frozen-lockfile
bun run apply
```

Start Pi, use `/login` to authenticate providers, then run `/reload`. Credentials and runtime state are not stored in this repository.

Pi loads this checkout directly as a local package. There is no build or copy step.

## Apply configuration

Preview changes:

```sh
bun run apply --dry-run
```

Apply changes:

```sh
bun run apply
```

The apply script:

- Merges `config/settings.json` into `~/.pi/agent/settings.json`.
- Registers the current checkout as the first local Pi package.
- Merges stable Better OpenAI preferences without resetting runtime state.
- Backs up changed files under `~/.pi/backups/apply-*`.
- Writes changes atomically.

It does not modify credentials, sessions, trust decisions, secrets, package caches, or workflow artifacts.

## Development

Pi reads extensions, skills, and themes directly from this checkout:

```text
edit -> validate -> /reload
```

Validate changes with:

```sh
bun run format:check
bun run check
bun test
```

Run `bun install --frozen-lockfile` after pulling dependency changes. Restart Pi after dependency or startup-setting changes.

## Safety

Subagents and pull-request workflows can run commands or modify repositories with your user permissions. The workflow sandbox restricts orchestration code, but child agents can still modify the current project. Review changes before committing.

## Rollback

Apply backups are stored under:

```text
~/.pi/backups/
```

To stop loading this checkout, remove its path from the `packages` array in `~/.pi/agent/settings.json`, then restart Pi.
