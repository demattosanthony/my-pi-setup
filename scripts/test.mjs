import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = resolve(repoRoot, "tests");
const liveOnly = process.argv.includes("--live");
const listOnly = process.argv.includes("--list");

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? findTests(path)
        : Promise.resolve(entry.name.endsWith(".test.ts") ? [path] : []);
    }),
  );
  return files.flat();
}

const allTests = (await findTests(testsRoot)).sort();
const selectedTests = allTests.filter((path) => {
  const live = path.endsWith(".live.test.ts");
  return liveOnly ? live : !live;
});

if (listOnly) {
  for (const path of allTests) {
    const kind = path.endsWith(".live.test.ts") ? "live" : "test";
    console.log(`[${kind}] ${relative(repoRoot, path)}`);
  }
  console.log(
    `${allTests.length} total: ${allTests.length - allTests.filter((path) => path.endsWith(".live.test.ts")).length} routine, ${allTests.filter((path) => path.endsWith(".live.test.ts")).length} live`,
  );
  process.exit(0);
}

if (selectedTests.length === 0) {
  console.error(`No ${liveOnly ? "live " : ""}tests found under tests/.`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", "--experimental-strip-types", ...selectedTests],
  { cwd: repoRoot, stdio: "inherit" },
);

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
