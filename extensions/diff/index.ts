import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDiffInRightPane, type OpenDiffOptions } from "./cmux.ts";
import {
  commitPatch,
  pullRequestPatch,
  type ExecFn,
  workingTreePatch,
} from "./patch.ts";
import {
  DIFF_COMPLETIONS,
  DIFF_USAGE,
  parseDiffRequest,
  type DiffRequest,
} from "./request.ts";

const STATUS_KEY = "diff-review";

export default function diffExtension(pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Review changes in cmux's diff viewer",
    getArgumentCompletions(prefix) {
      if (prefix.includes(" ")) return null;
      const normalized = prefix.trim().toLowerCase();
      const matches = DIFF_COMPLETIONS.filter((item) =>
        item.value.startsWith(normalized),
      );
      return matches.length > 0 ? [...matches] : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "/diff requires Pi's interactive TUI inside cmux",
          "error",
        );
        return;
      }

      let request: DiffRequest;
      try {
        request = parseDiffRequest(args);
      } catch (error) {
        ctx.ui.notify(messageFrom(error), "error");
        return;
      }
      if (request.kind === "help") {
        ctx.ui.notify(DIFF_USAGE, "info");
        return;
      }

      await ctx.waitForIdle();
      setStatus(ctx, "diff: preparing review");
      const exec: ExecFn = (command, commandArgs, options) =>
        pi.exec(command, commandArgs, options);

      try {
        const repoRoot = await getRepoRoot(exec, ctx.cwd);
        const title = reviewTitle(request, basename(repoRoot));
        const native = nativeDiffOptions(request, repoRoot, title, ctx);

        if (native) {
          setStatus(ctx, "diff: opening review pane");
          showOpenWarning(ctx, await openDiffInRightPane(exec, native));
          return;
        }

        setStatus(ctx, `diff: building ${request.kind} patch`);
        const patch = await patchFor(request, exec, repoRoot);
        if (!patch.trim()) {
          ctx.ui.notify(noChangesMessage(request), "info");
          return;
        }

        await withTemporaryPatch(patch, async (patchPath) => {
          setStatus(ctx, "diff: opening review pane");
          showOpenWarning(
            ctx,
            await openDiffInRightPane(exec, {
              cwd: repoRoot,
              title,
              patchPath,
            }),
          );
        });
      } catch (error) {
        ctx.ui.notify(messageFrom(error), "error");
      } finally {
        setStatus(ctx);
      }
    },
  });
}

function nativeDiffOptions(
  request: DiffRequest,
  repoRoot: string,
  title: string,
  ctx: ExtensionCommandContext,
): OpenDiffOptions | undefined {
  if (request.kind === "last-turn") {
    return {
      cwd: repoRoot,
      title,
      source: "last-turn",
      sessionId: ctx.sessionManager.getSessionId(),
    };
  }
  if (request.kind === "unstaged" || request.kind === "staged") {
    return { cwd: repoRoot, title, source: request.kind };
  }
  if (request.kind === "branch") {
    return { cwd: repoRoot, title, source: "branch", base: request.base };
  }
  return undefined;
}

async function patchFor(
  request: DiffRequest,
  exec: ExecFn,
  repoRoot: string,
): Promise<string> {
  if (request.kind === "working") return workingTreePatch(exec, repoRoot);
  if (request.kind === "commit")
    return commitPatch(exec, repoRoot, request.ref);
  if (request.kind === "pr")
    return pullRequestPatch(exec, repoRoot, request.target);
  throw new Error(`Unsupported patch source: ${request.kind}`);
}

async function getRepoRoot(exec: ExecFn, cwd: string): Promise<string> {
  const result = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: 5_000,
  });
  const root = result.stdout.trim();
  if (result.code !== 0 || !root) {
    throw new Error("/diff must be run from inside a Git repository");
  }
  return root;
}

async function withTemporaryPatch(
  patch: string,
  usePatch: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cmux-diff-"));
  const path = join(directory, "changes.patch");
  try {
    await writeFile(path, patch, { encoding: "utf8", mode: 0o600 });
    await usePatch(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function showOpenWarning(
  ctx: ExtensionCommandContext,
  result: Awaited<ReturnType<typeof openDiffInRightPane>>,
): void {
  if (result.warning) ctx.ui.notify(result.warning, "warning");
}

function reviewTitle(request: DiffRequest, repo: string): string {
  switch (request.kind) {
    case "working":
      return `Working tree · ${repo}`;
    case "last-turn":
      return `Last turn · ${repo}`;
    case "unstaged":
      return `Unstaged · ${repo}`;
    case "staged":
      return `Staged · ${repo}`;
    case "branch":
      return `Branch${request.base ? ` vs ${request.base}` : ""} · ${repo}`;
    case "commit":
      return `Commit ${request.ref} · ${repo}`;
    case "pr":
      return `PR ${request.target ?? "current branch"} · ${repo}`;
    case "help":
      return `Diff · ${repo}`;
  }
}

function noChangesMessage(request: DiffRequest): string {
  if (request.kind === "working") return "No working-tree changes to review.";
  if (request.kind === "commit")
    return `Commit ${request.ref} has no patch to review.`;
  return "The pull request has no patch to review.";
}

function setStatus(ctx: ExtensionCommandContext, text?: string): void {
  ctx.ui.setStatus(
    STATUS_KEY,
    text ? ctx.ui.theme.fg("accent", text) : undefined,
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
