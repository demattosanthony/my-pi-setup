/**
 * Git helpers for gathering reviewable diffs.
 *
 * All commands run through `pi.exec` (passed in as `ExecFn`) so they respect
 * the project cwd and participate in pi's process management.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewSource } from "./types.ts";

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

/** Hard cap on diff size sent to the model (~150KB ~= 35-40k tokens). */
const MAX_DIFF_BYTES = 150_000;
/** Per-file cap for synthesized untracked-file diffs. */
const MAX_UNTRACKED_LINES = 250;

async function run(exec: ExecFn, cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd });
  // git diff --name-only etc. exit non-zero only on real errors; diff with no
  // changes exits 0 with empty output. We treat stderr as best-effort.
  return (result.stdout ?? "").trimEnd();
}

export async function isGitRepo(exec: ExecFn, cwd: string): Promise<boolean> {
  try {
    const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
    });
    return result.code === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(
  exec: ExecFn,
  cwd: string,
): Promise<string | null> {
  const out = await run(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out || null;
}

/** True if the given ref resolves locally. */
async function refExists(
  exec: ExecFn,
  cwd: string,
  ref: string,
): Promise<boolean> {
  const result = await exec("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd,
  });
  return result.code === 0;
}

/** Detect the likely integration branch: origin/main, main, origin/master, master. */
export async function detectBaseBranch(
  exec: ExecFn,
  cwd: string,
): Promise<string | null> {
  const candidates = ["origin/main", "main", "origin/master", "master"];
  for (const ref of candidates) {
    if (await refExists(exec, cwd, ref)) return ref;
  }
  return null;
}

/** List local and remote branch short names. */
export async function listBranches(
  exec: ExecFn,
  cwd: string,
): Promise<string[]> {
  const local = await run(exec, cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const remote = await run(exec, cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes",
  ]);
  const set = new Set<string>();
  for (const line of local.split("\n")) {
    const name = line.trim();
    if (name) set.add(name);
  }
  for (const line of remote.split("\n")) {
    const name = line.trim();
    if (name && !name.endsWith("/HEAD")) set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function changedFiles(
  exec: ExecFn,
  cwd: string,
  args: string[],
): Promise<string[]> {
  const out = await run(exec, cwd, args);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Untracked, non-ignored files. */
async function untrackedFiles(exec: ExecFn, cwd: string): Promise<string[]> {
  return changedFiles(exec, cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
}

/** Build a synthetic diff for an untracked file so the model can review it. */
async function synthesizeUntrackedDiff(
  exec: ExecFn,
  cwd: string,
  path: string,
): Promise<string> {
  try {
    const content = await readFile(join(cwd, path), "utf8");
    const lines = content.split("\n");
    const capped = lines.slice(0, MAX_UNTRACKED_LINES);
    const truncatedNote =
      lines.length > MAX_UNTRACKED_LINES
        ? `\n# [file truncated: showing ${MAX_UNTRACKED_LINES} of ${lines.length} lines]`
        : "";
    const body = capped.map((l) => `+${l}`).join("\n");
    return [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${capped.length} @@`,
      body,
      truncatedNote,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    // Binary or unreadable file; surface a stub so it still appears.
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+[untracked file: unreadable or binary]`;
  }
}

/** Truncate a diff to MAX_DIFF_BYTES, preserving a clear truncation marker. */
function capDiff(diff: string): { diff: string; truncated: boolean } {
  const result = truncateHead(diff, { maxBytes: MAX_DIFF_BYTES });
  if (!result.truncated) return { diff, truncated: false };
  const note = `\n\n# [diff truncated: kept ${result.outputBytes} of ${result.totalBytes} bytes; ${result.outputLines} of ${result.totalLines} lines. Review covers the shown portion.]`;
  return { diff: result.content + note, truncated: true };
}

export async function gatherWorkingChanges(
  exec: ExecFn,
  cwd: string,
): Promise<ReviewSource> {
  const tracked = await changedFiles(exec, cwd, [
    "diff",
    "--name-only",
    "HEAD",
  ]);
  const untracked = await untrackedFiles(exec, cwd);
  const files = [...tracked, ...untracked];

  let diff = await run(exec, cwd, ["--no-pager", "diff", "--no-color", "HEAD"]);
  for (const path of untracked) {
    const piece = await synthesizeUntrackedDiff(exec, cwd, path);
    diff += `\n${piece}`;
  }
  const capped = capDiff(diff);
  return {
    kind: "working",
    label: `Working changes (${files.length} file${files.length === 1 ? "" : "s"})`,
    files,
    diff: capped.diff,
    truncated: capped.truncated,
  };
}

export async function gatherStagedChanges(
  exec: ExecFn,
  cwd: string,
): Promise<ReviewSource> {
  const files = await changedFiles(exec, cwd, [
    "diff",
    "--name-only",
    "--cached",
  ]);
  const diff = await run(exec, cwd, [
    "--no-pager",
    "diff",
    "--no-color",
    "--cached",
  ]);
  const capped = capDiff(diff);
  return {
    kind: "staged",
    label: `Staged changes (${files.length} file${files.length === 1 ? "" : "s"})`,
    files,
    diff: capped.diff,
    truncated: capped.truncated,
  };
}

export async function gatherPrChanges(
  exec: ExecFn,
  cwd: string,
  base: string,
): Promise<ReviewSource> {
  // merge-base gives the PR-style diff: changes on this branch since it diverged.
  const mbResult = await exec("git", ["merge-base", base, "HEAD"], { cwd });
  const mergeBase = mbResult.stdout.trim();
  if (!mergeBase) {
    throw new Error(
      `[Code Review] Could not compute merge-base of ${base} and HEAD`,
    );
  }
  const files = await changedFiles(exec, cwd, [
    "diff",
    "--name-only",
    mergeBase,
    "HEAD",
  ]);
  const diff = await run(exec, cwd, [
    "--no-pager",
    "diff",
    "--no-color",
    mergeBase,
    "HEAD",
  ]);
  const capped = capDiff(diff);
  return {
    kind: "pr",
    label: `PR: HEAD vs ${base} (${files.length} file${files.length === 1 ? "" : "s"})`,
    base,
    files,
    diff: capped.diff,
    truncated: capped.truncated,
  };
}
