# Setup and maintenance

## Prerequisites

- Pi coding agent
- Node.js and npm
- Git
- `gh` for pull request dashboard information
- `fd` and `rg` are recommended; the file-search extension can install verified fallback binaries when absent
- Claude Code and Codex CLIs are optional subagent backends
- macOS `pbcopy` is required by `/copy-all`

## Install on a new computer

Clone the personal fork at the stable local-package path:

```sh
mkdir -p ~/projects
git clone https://github.com/demattosanthony/my-pi-setup.git ~/projects/my-pi-setup
cd ~/projects/my-pi-setup
git remote add upstream https://github.com/davis7dotsh/my-pi-setup.git
npm install
npm run apply
```

Start Pi and authenticate providers with `/login`. API keys and provider credentials are not stored in this repository.

The apply command registers the absolute checkout path as a local Pi package in `~/.pi/agent/settings.json`. Pi then loads resources directly from the checkout.

## Applying configuration

Preview changes:

```sh
npm run apply -- --dry-run
```

Apply changes:

```sh
npm run apply
```

The apply script:

1. Reads desired settings from `config/`.
2. Preserves existing Pi-managed and unrecognized settings.
3. Makes this checkout the first configured Pi package.
4. Synchronizes `models.json` and the Better OpenAI configuration.
5. Backs up changed destination files under `~/.pi/backups/apply-*`.
6. Writes files atomically.

It does not modify authentication, sessions, trust decisions, secrets, package caches, or workflow artifacts.

## Daily development

Extensions, skills, prompts, and themes are loaded from the checkout itself:

```text
edit repository -> validate -> /reload
```

Recommended validation:

```sh
npm run format:check
npm run check
npm test
```

Use a full Pi restart after dependency changes or settings that affect startup. `config/models.json` is also re-read whenever `/model` opens.

## Adding a resource

Add the source under the appropriate directory, then update the `pi` manifest in `package.json` when adding an extension entry point. Skills and themes are discovered from their declared directories.

After adding a dependency, install it with npm rather than manually editing dependency versions:

```sh
npm install <package>
```

Use `npm install --workspace <workspace> <package>` for a dependency owned by one extension workspace.

## Firecrawl (optional)

`extensions/firecrawl-search` is intentionally excluded from the active `pi.extensions` manifest because this setup uses `pi-web-access` for web search and content fetching.

To enable Firecrawl:

1. Add `./extensions/firecrawl-search/index.ts` to `pi.extensions` in `package.json`.
2. Create `~/.pi/agent/.env` containing:

   ```sh
   FIRECRAWL_API_KEY=fc-YOUR-API-KEY
   ```

3. Run `/reload`.

Never commit `.env` or an API key.

## Footer ownership

`ui-customization` owns the replacement Pi footer. The tracked Better OpenAI config uses footer mode `status`, allowing its usage status to appear without replacing the custom dashboard footer.

## Command ownership

- `/pr` is the personal pull-request workflow.
- `/pr-info` refreshes the upstream git/PR dashboard information.
- `/review` is the personal code-review workflow.

## Security notes

Extensions execute with the user's full permissions.

The subagent extension can launch autonomous children:

- Claude Code uses bypassed interactive permissions.
- Codex uses danger-full-access with approvals disabled.
- Pi children inherit most global resources.

The workflow extension runs orchestration code in a permission-restricted Node child, but its child agents can still modify the current project. Review changes before committing and disable these entry points in the package manifest if this behavior is not desired.

## Updating from upstream

Keep personal changes on top of the upstream history:

```sh
cd ~/projects/my-pi-setup
git fetch upstream
git merge upstream/main
npm install
npm run format:check
npm run check
npm test
```

Resolve conflicts deliberately, especially in:

- `package.json`
- `extensions/git-info/index.ts`
- `extensions/ui-customization/index.ts`
- setup documentation

After validation, run `/reload` in Pi.

## Rollback

Migration and apply backups are stored under:

```text
~/.pi/backups/
```

To stop loading this checkout, remove its absolute path from the `packages` array in `~/.pi/agent/settings.json` and restart Pi.

Do not delete the old top-level extension or skill copies until the local package has been loaded and verified successfully.
