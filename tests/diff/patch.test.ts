import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreePatch, type ExecFn } from "../../extensions/diff/patch.ts";

const temporaryPaths: string[] = [];

const exec: ExecFn = async (command, args, options) => {
  const child = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, killed: false };
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workingTreePatch", () => {
  test("combines staged, unstaged, and untracked changes", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "staged.txt"), "staged change\n");
    await git(repo, "add", "staged.txt");
    await writeFile(join(repo, "unstaged.txt"), "unstaged change\n");
    await writeFile(join(repo, "new file.txt"), "new content\n");
    await writeFile(join(repo, "empty.txt"), "");

    const patch = await workingTreePatch(exec, repo);

    expect(patch).toContain("staged change");
    expect(patch).toContain("unstaged change");
    expect(patch).toContain("new content");
    expect(patch).toContain("new file.txt");
    expect(patch).toContain("diff --git a/empty.txt b/empty.txt");
  });

  test("returns an empty patch for a clean repository", async () => {
    const repo = await createRepo();
    expect(await workingTreePatch(exec, repo)).toBe("");
  });
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
  temporaryPaths.push(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Pi Diff Tests");
  await git(repo, "config", "user.email", "pi-diff@example.invalid");
  await writeFile(join(repo, "staged.txt"), "original staged\n");
  await writeFile(join(repo, "unstaged.txt"), "original unstaged\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "initial");
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await exec("git", args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr);
}
