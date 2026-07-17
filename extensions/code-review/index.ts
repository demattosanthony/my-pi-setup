/**
 * Code Review extension for pi.
 *
 * Adds the `/review` command: a TUI workflow that reviews either uncommitted
 * working changes or a PR-style diff against a base branch, then browses the
 * findings (bugs, issues, simplifications, duplications, security, perf, ...).
 *
 *   /review            pick what to review
 *   /review working    review uncommitted changes
 *   /review staged     review staged changes
 *   /review pr         review current branch vs auto-detected main
 *   /review pr main    review current branch vs a specific base
 *
 * From the results browser, press `f`/Enter to send a finding to the agent for
 * fixing, `e` to export a markdown report, `r` to re-run, and `q` to quit.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pickOption, ReviewProgress, ResultsBrowser } from "./components.ts";
import {
  currentBranch,
  detectBaseBranch,
  gatherPrChanges,
  gatherStagedChanges,
  gatherWorkingChanges,
  isGitRepo,
  listBranches,
  type ExecFn,
} from "./git.ts";
import {
  parseReview,
  renderReviewMarkdown,
  runReviewStream,
  type ModelAuth,
} from "./review.ts";
import {
  SEVERITY_META,
  type Finding,
  type ReviewAction,
  type ReviewResult,
  type ReviewSource,
} from "./types.ts";

export default function codeReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Review code changes (working, staged, or PR) in a TUI",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const opts = ["working", "staged", "pr"];
      const items = opts.map((o) => ({ value: o, label: o }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/review requires interactive mode", "error");
        return;
      }
      const exec: ExecFn = (cmd, a, opts) =>
        pi.exec(cmd, a, { cwd: ctx.cwd, ...opts });

      if (!(await isGitRepo(exec, ctx.cwd))) {
        ctx.ui.notify("Not a git repository.", "error");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model selected. Use /model first.", "error");
        return;
      }
      const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!authResult.ok || !authResult.apiKey) {
        ctx.ui.notify(
          authResult.ok
            ? `No API key for ${model.provider}/${model.id}`
            : authResult.error,
          "error",
        );
        return;
      }
      const auth: ModelAuth = {
        apiKey: authResult.apiKey,
        headers: authResult.headers ?? {},
        ...(authResult.env ? { env: authResult.env } : {}),
      };
      const reasoning =
        model.reasoning && pi.getThinkingLevel() !== "off"
          ? pi.getThinkingLevel()
          : undefined;

      let source = await resolveSource(exec, ctx, args);
      if (!source) return;
      if (source.diff.trim() === "" && source.files.length === 0) {
        ctx.ui.notify("No changes to review.", "info");
        return;
      }

      let result = await runReview(ctx, source, model, auth, reasoning);
      if (!result) {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      while (true) {
        const action = await showResults(ctx, result, source, model);
        if (action.action === "close") {
          return;
        }
        if (action.action === "fix") {
          pi.sendUserMessage(buildFixPrompt(action.finding, source));
          return;
        }
        if (action.action === "export") {
          const path = await exportReview(result, source, ctx.cwd);
          ctx.ui.notify(`Review exported to ${path}`, "info");
          continue;
        }
        if (action.action === "rerun") {
          const again = await runReview(ctx, source, model, auth, reasoning);
          if (!again) {
            ctx.ui.notify("Review cancelled.", "info");
            return;
          }
          result = again;
          continue;
        }
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Source resolution                                                   */
/* ------------------------------------------------------------------ */

async function resolveSource(
  exec: ExecFn,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<ReviewSource | null> {
  const a = (args ?? "").trim().toLowerCase();
  if (a === "working") return gatherWorkingChanges(exec, ctx.cwd);
  if (a === "staged") return gatherStagedChanges(exec, ctx.cwd);
  if (a === "pr" || a.startsWith("pr ")) {
    const explicit = a.startsWith("pr ") ? a.slice(3).trim() : "";
    if (explicit) return gatherPrChanges(exec, ctx.cwd, explicit);
    const auto = await detectBaseBranch(exec, ctx.cwd);
    if (auto) return gatherPrChanges(exec, ctx.cwd, auto);
    const base = await pickBaseBranch(exec, ctx);
    return base ? gatherPrChanges(exec, ctx.cwd, base) : null;
  }
  return pickSource(exec, ctx);
}

async function pickSource(
  exec: ExecFn,
  ctx: ExtensionCommandContext,
): Promise<ReviewSource | null> {
  const main = await detectBaseBranch(exec, ctx.cwd);
  const items: SelectItem[] = [
    {
      value: "working",
      label: "Working changes",
      description: "Uncommitted changes (staged + unstaged + untracked)",
    },
    {
      value: "staged",
      label: "Staged changes",
      description: "Changes staged for commit",
    },
  ];
  if (main) {
    items.push({
      value: `pr:${main}`,
      label: `PR vs ${main}`,
      description: "Changes on this branch since it diverged",
    });
  }
  items.push({
    value: "pick-base",
    label: "PR vs base branch…",
    description: "Choose a branch to diff against",
  });

  const choice = await pickOption(
    ctx,
    "Review what?",
    "↑↓ navigate · enter select · esc cancel",
    items,
  );
  if (!choice) return null;

  if (choice === "working") return gatherWorkingChanges(exec, ctx.cwd);
  if (choice === "staged") return gatherStagedChanges(exec, ctx.cwd);
  if (choice === "pick-base") {
    const base = await pickBaseBranch(exec, ctx);
    return base ? gatherPrChanges(exec, ctx.cwd, base) : null;
  }
  if (choice.startsWith("pr:"))
    return gatherPrChanges(exec, ctx.cwd, choice.slice(3));
  return null;
}

async function pickBaseBranch(
  exec: ExecFn,
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  const branches = await listBranches(exec, ctx.cwd);
  if (branches.length === 0) {
    ctx.ui.notify("No branches found.", "warning");
    return null;
  }
  const current = await currentBranch(exec, ctx.cwd);
  const items: SelectItem[] = branches
    .filter((b) => b !== current && b !== "HEAD")
    .map((b) => ({ value: b, label: b }));
  if (items.length === 0) {
    ctx.ui.notify("No other branches to diff against.", "warning");
    return null;
  }
  return pickOption(
    ctx,
    "Diff against which branch?",
    "↑↓ navigate · enter select · esc cancel",
    items,
  );
}

/* ------------------------------------------------------------------ */
/* Review execution + results UI                                       */
/* ------------------------------------------------------------------ */

async function runReview(
  ctx: ExtensionCommandContext,
  source: ReviewSource,
  model: Model<Api>,
  auth: ModelAuth,
  reasoning: string | undefined,
): Promise<ReviewResult | null> {
  return ctx.ui.custom<ReviewResult | null>((tui, theme, _kb, done) => {
    const progress = new ReviewProgress(
      tui,
      theme,
      source.label,
      model.id,
      source.files.length,
    );
    const ac = new AbortController();
    progress.onCancel = () => ac.abort();

    (async () => {
      try {
        const raw = await runReviewStream(model, auth, source, {
          signal: ac.signal,
          reasoning,
          onDelta: (chunk) => {
            progress.preview += chunk;
            progress.phase = "Reviewing…";
            progress.requestRender();
          },
        });
        if (raw == null) {
          done(null);
          return;
        }
        progress.phase = "Parsing findings…";
        progress.requestRender();
        done(parseReview(raw));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        done({ summary: `Review failed: ${msg}`, findings: [], raw: "" });
      }
    })();

    return progress;
  });
}

async function showResults(
  ctx: ExtensionCommandContext,
  result: ReviewResult,
  source: ReviewSource,
  model: Model<Api>,
): Promise<ReviewAction> {
  return ctx.ui.custom<ReviewAction>((tui, theme, _kb, done) => {
    const browser = new ResultsBrowser(tui, theme, result, source, model.id);
    browser.onAction = (action) => done(action);
    return browser;
  });
}

/* ------------------------------------------------------------------ */
/* Fix prompt + export                                                 */
/* ------------------------------------------------------------------ */

function buildFixPrompt(f: Finding, source: ReviewSource): string {
  const meta = SEVERITY_META[f.severity];
  return [
    `Fix this code review finding (${meta.label} / ${f.category}):`,
    "",
    `File: ${f.file}${f.lines ? `:${f.lines}` : ""}`,
    `Title: ${f.title}`,
    "",
    "Problem:",
    f.description,
    "",
    "Suggested fix:",
    f.suggestion || "(none provided)",
    "",
    `Context: reviewed as part of "${source.label}".`,
    "",
    "Please address this issue. Read the relevant code first, make a focused, minimal fix, and verify it.",
  ].join("\n");
}

async function exportReview(
  result: ReviewResult,
  source: ReviewSource,
  cwd: string,
): Promise<string> {
  const md = renderReviewMarkdown(result, source);
  const path = join(cwd, `code-review-${timestamp()}.md`);
  await writeFile(path, md, "utf8");
  return path;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
