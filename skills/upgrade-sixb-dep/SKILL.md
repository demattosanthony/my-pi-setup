---
name: upgrade-sixb-dep
description: Upgrade the sixb framework dependency inside downstream sixb projects that consume sixb as a submodule. Use only for application/project repos that depend on sixb, not for development work within the sixb framework repo itself.
---

This skill is only for downstream sixb projects that consume the sixb framework as a dependency. Do not use it for development work inside the sixb framework repository itself.

Currently the usage of sixb as a dep is through submodules. Your task is to update that submodule by checking out the main branch and pulling the latest changes.

You should analyze the diffs from its current state to all the changes that have been made since then, and you should keep track of a list of anything that needs to be upgrade within the project. This could be things like how the DX is shaped or removal of certain things.

The framework also currenlty mainly updates the database migrations files just inside of 001 and doesnt use the migration system yet since its early. So note any changes that been made directly to the migration files, and create a .sql file of what we need to update inside of projects database so that when we deploy and migrations run things don't fail. Ensure any generated .sql targets the proper schema that is being used in postgres. If its not clear from the config consult with the user. You also may need to direclty update the sixb_migrations table so that when the migrator runs it runs successfully.

When preparing a pull request, make the scope explicit in both the PR title and description: this is a downstream sixb project dependency upgrade, not a change to the sixb framework itself. Avoid wording that implies framework development or framework release work. Example title: `Upgrade sixb dependency in <project name>`. In the description, include a note like: `This PR updates the sixb submodule used by this project; it does not modify the sixb framework repository itself.`
