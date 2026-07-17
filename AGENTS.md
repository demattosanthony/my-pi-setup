# Repository instructions

This repository is the source of truth for a live Pi setup.

- Never commit authentication, API keys, `.env` files, sessions, trust decisions, run history, package caches, workflow artifacts, or downloaded binaries.
- Add dependencies with npm commands rather than manually editing dependency versions.
- Keep Pi resource entry points explicit in the root `package.json` manifest.
- Preserve compatibility with the Pi version documented by the lockfile and run `npm install` after dependency changes.
- Run `npm run format:check`, `npm run check`, and `npm test` after code changes.
- Keep live Claude Code and Codex tests opt-in; routine tests must not unexpectedly consume provider usage.
- Treat changes to subagent permissions, workflow sandboxing, tool registration, and runtime configuration as security-sensitive.
- Keep `config/` free of secrets. Use environment-variable references for credentials.
- Update `README.md` or `SETUP.md` when the installation or reload workflow changes.
