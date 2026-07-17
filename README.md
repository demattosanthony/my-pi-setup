# Anthony's Pi setup

This repository is the version-controlled source of truth for Anthony DeMattos' global [Pi coding agent](https://pi.dev) setup.

Pi loads extensions, skills, prompts, and themes directly from this checkout as a local Pi package. Runtime state remains in `~/.pi/agent` and is not committed.

## Included resources

- GitHub Dark Default theme
- Ask-user multiple-choice tool
- `fd` and `rg` model tools
- Self-contained custom header and footer
- Pi, Claude Code, and Codex subagents
- Model-authored multi-agent workflows
- Personal code-review and pull-request workflows
- Personal subagent and framework-upgrade skills
- `pi-web-access`, `pi-cmux`, and `pi-better-openai` packages

## Repository and runtime layout

```text
~/projects/my-pi-setup/  # tracked source of truth
~/.pi/agent/             # private/runtime state
```

Tracked here:

- Extension and skill source
- Themes and prompts
- Desired Pi settings
- Non-secret extension configuration
- Dependency versions
- Setup and maintenance documentation

Never tracked here:

- Provider authentication or API keys
- Sessions and run history
- Project trust decisions
- Package caches and `node_modules`
- Workflow artifacts and downloaded binaries

## Daily workflow

After editing an extension, skill, prompt, or theme:

```sh
cd ~/projects/my-pi-setup
npm run check
npm test
```

Then run `/reload` in Pi. Pi reads the changed source directly from this checkout; there is no copy or reinstall step.

After changing `config/settings.json` or `config/pi-better-openai.json`:

```sh
npm run apply
```

Then run `/reload`. Restart Pi for settings that only take effect during startup.

## Commands

```sh
npm install          # Install all root and extension workspace dependencies
npm run apply        # Apply tracked configuration to ~/.pi/agent
npm run apply -- --dry-run
npm run check        # Type-check all extensions
npm test             # Run non-live tests
npm run format       # Format tracked source/config
npm run format:check
```

Live Claude Code and Codex subagent tests remain opt-in:

```sh
npm run test:live --workspace subagents
```

See [SETUP.md](SETUP.md) for initial installation, migration, rollback, and upstream update instructions.
