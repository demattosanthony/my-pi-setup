# Code Review

A pi extension that adds a `/review` command with a full TUI for reviewing code
changes — uncommitted working changes, staged changes, or a PR-style diff
against a base branch.

## Usage

```
/review            # pick what to review
/review working    # uncommitted changes (staged + unstaged + untracked)
/review staged     # staged changes only
/review pr         # current branch vs auto-detected main/master
/review pr main    # current branch vs a specific base
```

Tab-completes the subcommand. Run `/reload` (or restart pi) after first install
to pick up the extension.

## What it reviews

The model reviews the unified diff (plus synthesized diffs for untracked files)
and reports findings across these categories:

- **bug** — logic errors, null mishandling, off-by-one, races, broken contracts
- **issue** — correctness risks, edge cases, missing validation
- **security** — injection, auth, secrets, path traversal
- **simplification** — overly complex code that can be clearer
- **duplication** — copy-pasted logic worth extracting
- **performance** — wasteful work, N+1, unnecessary allocations
- **maintainability** — naming, missing context, hard-to-test code

It uses your currently selected model (`/model`) and current thinking level, and
streams the response with a live preview.

## Results browser keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` or `k` / `j` | Move selection |
| `Enter` or `f` | Send the selected finding to the agent to fix |
| `e` | Export a markdown report to `code-review-<timestamp>.md` |
| `r` | Re-run the review on the same source |
| `Tab` or `0`–`4` | Cycle / jump to severity filter (all / critical / warning / info / suggestion) |
| `g` / `G` | Jump to top / bottom |
| `J` / `K` | Scroll the detail pane |
| `q` or `Esc` | Close |

The browser shows a severity summary, a scrollable findings list, and a detail
pane (file:lines, description, suggested fix) for the selected finding.

## Files

- `index.ts` — command registration and workflow orchestration
- `components.ts` — TUI components (picker, streaming loader, results browser)
- `review.ts` — review prompt, streaming call, and JSON parsing
- `git.ts` — diff gathering for working / staged / PR sources
- `types.ts` — shared types and severity metadata
