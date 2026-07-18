---
name: upgrade-sixb-deps
description: Upgrade the sixb framework dependency (git submodule) in a downstream sixb project. Not for development work inside the sixb framework repo itself.
---

Upgrade this project's sixb submodule to the latest `main`. If this repo **is** the sixb framework repo, stop and tell the user — this skill is only for downstream consumers.

1. **Update the submodule** — check out `main` and pull the latest changes inside the sixb submodule directory.
2. **Analyze the diff** — compare the previous submodule commit to the new one (`git log` + full diff). Review everything and build an upgrade plan covering:
   - **Security/permission grants** — new or changed tool grants, sandbox, or trust settings to port into this project's config
   - **DX changes** — new or changed commands, scripts, file layout, or conventions to adopt
   - **Removals/deprecations** — anything this project still uses that was removed or replaced
   - **New config/env vars** — add via environment-variable references; never commit secrets
3. **Apply the plan** to the project, keeping changes minimal.
4. **Database** — sixb edits the `001` migration files directly (no migration system yet). For every migration-file change, write a `.sql` catch-up file so deployed databases stay in sync:
   - Target the correct postgres schema; if it's not clear from the config, ask the user.
   - Update the `sixb_migrations` table in that `.sql` if needed so the migrator runs cleanly.
5. **Verify** — run the project's own checks/tests before finishing.
