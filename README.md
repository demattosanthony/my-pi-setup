# my pi setup

This is my opinionated [Pi](https://pi.dev) setup. It:

- uses Carbonfox as default theme
- adds a custom header and footer
- adds an ask-user tool for multiple-choice questions
- adds first-class `fd` and `rg` tools
- adds Pi, Claude Code, and Codex subagents
- adds multi-agent workflows
- adds a cmux-native `/diff` workflow for reviewing changes beside the Pi chat
- adds code-review and pull-request workflows
- adds local audio transcription and Markdown call notes with `/call-notes`
- includes my personal skills and preferred Pi packages

![Pi setup interface](assets/pi-setup.jpeg)

**Note:** setup instructions are in [`SETUP.md`](SETUP.md).

## Diff review

`/diff` opens the complete working-tree diff in a cmux browser pane to the right of Pi, including staged, unstaged, and untracked files. When a right pane already exists, each review opens as a new tab there instead of creating another split.

```text
/diff                  # complete working tree
/diff last             # latest agent turn
/diff staged
/diff unstaged
/diff branch [base]
/diff commit [ref]
/diff pr [number|url]
```

Use cmux's inline diff comments to collect line-level feedback while keeping the Pi chat visible. See [`SETUP.md`](SETUP.md) for the native Pi hook that enables last-turn snapshots.
