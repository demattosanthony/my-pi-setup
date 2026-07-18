import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

const GIT_DIFF_OPTIONS = ["--binary", "--no-ext-diff", "--no-color"];
const COMMAND_TIMEOUT_MS = 60_000;

export async function workingTreePatch(
  exec: ExecFn,
  repoRoot: string,
): Promise<string> {
  const hasHead = await exec(
    "git",
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    {
      cwd: repoRoot,
      timeout: COMMAND_TIMEOUT_MS,
    },
  );

  const tracked =
    hasHead.code === 0
      ? await gitPatch(exec, repoRoot, [
          "diff",
          ...GIT_DIFF_OPTIONS,
          "HEAD",
          "--",
        ])
      : joinPatches([
          await gitPatch(exec, repoRoot, [
            "diff",
            ...GIT_DIFF_OPTIONS,
            "--cached",
            "--",
          ]),
          await gitPatch(exec, repoRoot, ["diff", ...GIT_DIFF_OPTIONS, "--"]),
        ]);

  const untrackedResult = await run(
    exec,
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repoRoot,
  );
  const untrackedPaths = untrackedResult.stdout.split("\0").filter(Boolean);
  const untrackedPatches = await mapConcurrent(
    untrackedPaths,
    8,
    async (path) => {
      const result = await exec(
        "git",
        ["diff", ...GIT_DIFF_OPTIONS, "--no-index", "--", "/dev/null", path],
        { cwd: repoRoot, timeout: COMMAND_TIMEOUT_MS },
      );
      if (result.code !== 0 && result.code !== 1) {
        throw commandError("git diff", result);
      }
      return result.stdout || emptyFilePatch(path);
    },
  );

  return joinPatches([tracked, ...untrackedPatches]);
}

export async function commitPatch(
  exec: ExecFn,
  repoRoot: string,
  ref: string,
): Promise<string> {
  return gitPatch(exec, repoRoot, [
    "--no-pager",
    "show",
    "--format=",
    ...GIT_DIFF_OPTIONS,
    "--find-renames",
    ref,
    "--",
  ]);
}

export async function pullRequestPatch(
  exec: ExecFn,
  repoRoot: string,
  target?: string,
): Promise<string> {
  const args = ["pr", "diff"];
  if (target) args.push(target);
  args.push("--color", "never");
  const result = await run(exec, "gh", args, repoRoot);
  return result.stdout;
}

async function gitPatch(
  exec: ExecFn,
  repoRoot: string,
  args: string[],
): Promise<string> {
  return (await run(exec, "git", args, repoRoot)).stdout;
}

async function run(
  exec: ExecFn,
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  const result = await exec(command, args, {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.killed) throw new Error(`${command} timed out`);
  if (result.code !== 0)
    throw commandError(`${command} ${args.slice(0, 2).join(" ")}`, result);
  return result;
}

function commandError(
  label: string,
  result: Pick<ExecResult, "code" | "stdout" | "stderr">,
): Error {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exited with code ${result.code}`;
  return new Error(`${label} failed: ${detail}`);
}

function joinPatches(patches: string[]): string {
  const parts = patches.map((patch) => patch.trimEnd()).filter(Boolean);
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

function emptyFilePatch(path: string): string {
  return [
    `diff --git ${quoteGitPath(`a/${path}`)} ${quoteGitPath(`b/${path}`)}`,
    "new file mode 100644",
    "index 0000000..e69de29",
  ].join("\n");
}

function quoteGitPath(path: string): string {
  if (!/[\t\n\r"\\]/.test(path)) return path;
  return `"${path
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await map(values[index]!);
      }
    }),
  );
  return results;
}
