import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildFdArgs,
  buildRgArgs,
  FD_DEFAULT_LIMIT,
  normalizeSearchPath,
} from "./src/args.ts";
import {
  FD_INTEL_DARWIN_VERSION,
  InstallError,
  readBoundedResponse,
  releaseAsset,
  resolveBinary,
  TOOL_SPECS,
  UnsupportedPlatformError,
  type BinaryEnv,
  type ReleaseAsset,
  type ResolvedBinary,
} from "./src/binaries.ts";
import { formatCapturedOutput, formatOutput } from "./src/output.ts";
import { executeSearchProcess } from "./src/process.ts";
import { installNotifications, makeBinaryInitializers } from "./index.ts";

test("fd builds safe arguments with defaults and options", () => {
  assert.deepEqual(buildFdArgs({}), [
    "--color=never",
    "--max-results",
    String(FD_DEFAULT_LIMIT),
    "--",
    "",
  ]);
  assert.deepEqual(
    buildFdArgs({
      pattern: "-rf",
      path: "@src",
      type: "file",
      extension: ".ts",
      glob: true,
      hidden: true,
      max_depth: 3,
      limit: 50,
    }),
    [
      "--color=never",
      "--hidden",
      "--glob",
      "--type",
      "f",
      "--extension",
      "ts",
      "--max-depth",
      "3",
      "--max-results",
      "50",
      "--",
      "-rf",
      "src",
    ],
  );
});

test("fd clamps out-of-range values", () => {
  assert.deepEqual(buildFdArgs({ max_depth: 500, limit: 1_000_000 }), [
    "--color=never",
    "--max-depth",
    "64",
    "--max-results",
    "10000",
    "--",
    "",
  ]);
});

test("rg builds safe arguments and supports all options", () => {
  assert.deepEqual(buildRgArgs({ pattern: "--help" }), [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--smart-case",
    "--max-count",
    "100",
    "--",
    "--help",
  ]);
  const args = buildRgArgs({
    pattern: "TODO",
    path: "@lib",
    glob: "*.ts",
    file_type: "ts",
    case_sensitive: true,
    fixed_strings: true,
    hidden: true,
    context: 2,
    limit: 10,
  });
  assert.deepEqual(args.slice(-3), ["--", "TODO", "lib"]);
  assert.ok(args.includes("--fixed-strings"));
  assert.ok(args.includes("--case-sensitive"));
});

test("search paths normalize model prefixes and home paths", () => {
  assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
  assert.equal(normalizeSearchPath("~"), homedir());
  assert.equal(normalizeSearchPath("~/projects"), join(homedir(), "projects"));
  assert.equal(normalizeSearchPath(" plain "), "plain");
});

function makeEnv(options: {
  available?: string[];
  installShouldFail?: boolean;
}): BinaryEnv & { installs: ReleaseAsset[]; probes: string[] } {
  const installs: ReleaseAsset[] = [];
  const probes: string[] = [];
  const installed = new Set<string>();
  return {
    installs,
    probes,
    async probe(command) {
      probes.push(command);
      return (
        (options.available ?? []).includes(command) || installed.has(command)
      );
    },
    async install(asset, destination) {
      if (options.installShouldFail) throw new InstallError("network down");
      installs.push(asset);
      installed.add(destination);
    },
  };
}

const darwinArm = { os: "darwin", arch: "arm64" } as const;

test("binary resolution prefers system commands and fdfind", async () => {
  const fd = await resolveBinary(
    TOOL_SPECS.fd,
    "/repo/bin",
    darwinArm,
    makeEnv({ available: ["fd"] }),
  );
  assert.deepEqual(fd, { tool: "fd", command: "fd", source: "system" });

  const fdfind = await resolveBinary(
    TOOL_SPECS.fd,
    "/repo/bin",
    darwinArm,
    makeEnv({ available: ["fdfind"] }),
  );
  assert.equal(fdfind.command, "fdfind");
});

test("binary resolution uses an existing repository fallback", async () => {
  const resolved = await resolveBinary(
    TOOL_SPECS.rg,
    "/repo/bin",
    darwinArm,
    makeEnv({ available: ["/repo/bin/rg"] }),
  );
  assert.deepEqual(resolved, {
    tool: "rg",
    command: "/repo/bin/rg",
    source: "bundled",
  });
});

test("binary resolution installs once when no binary exists", async () => {
  const env = makeEnv({});
  const resolved = await resolveBinary(
    TOOL_SPECS.rg,
    "/repo/bin",
    darwinArm,
    env,
  );
  assert.equal(resolved.source, "installed");
  assert.equal(env.installs.length, 1);
  assert.match(env.installs[0]!.url, /^https:\/\/github\.com\/BurntSushi/);
});

test("binary resolution surfaces install and platform errors", async () => {
  await assert.rejects(
    resolveBinary(
      TOOL_SPECS.fd,
      "/repo/bin",
      darwinArm,
      makeEnv({ installShouldFail: true }),
    ),
    (error) =>
      error instanceof InstallError && error.message === "network down",
  );
  await assert.rejects(
    resolveBinary(
      TOOL_SPECS.fd,
      "/repo/bin",
      { os: "linux", arch: "s390x" },
      makeEnv({}),
    ),
    UnsupportedPlatformError,
  );
});

test("one failed binary initializer does not disable the other", async () => {
  const initializers = makeBinaryInitializers(
    "/repo/bin",
    darwinArm,
    makeEnv({ available: ["rg"], installShouldFail: true }),
  );
  await assert.rejects(initializers.fd, InstallError);
  assert.deepEqual(await initializers.rg, {
    tool: "rg",
    command: "rg",
    source: "system",
  });
});

test("release assets cover supported targets with pinned hashes", () => {
  for (const os of ["darwin", "linux"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      for (const tool of ["fd", "rg"] as const) {
        const asset = releaseAsset(tool, { os, arch });
        assert.ok(asset);
        assert.match(asset.url, /^https:\/\//);
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      }
    }
  }
  assert.equal(
    releaseAsset("fd", { os: "darwin", arch: "x64" })?.version,
    FD_INTEL_DARWIN_VERSION,
  );
  assert.match(
    releaseAsset("fd", { os: "linux", arch: "x64" })?.url ?? "",
    /unknown-linux-musl/,
  );
});

test("bounded downloads reject oversized declared and streamed bodies", async () => {
  await assert.rejects(
    readBoundedResponse(
      new Response("small", { headers: { "content-length": "100" } }),
      10,
    ),
    /size limit/,
  );
  await assert.rejects(
    readBoundedResponse(new Response("this body is too large"), 5),
    /size limit/,
  );
});

test("only freshly installed binaries produce notifications", () => {
  const system: ResolvedBinary = {
    tool: "fd",
    command: "fd",
    source: "system",
  };
  const installed: ResolvedBinary = {
    tool: "rg",
    command: "/repo/bin/rg",
    source: "installed",
    version: "15.2.0",
  };
  assert.deepEqual(installNotifications([system]), []);
  assert.match(installNotifications([installed])[0]!, /downloaded rg 15\.2\.0/);
});

test("process output streams to a complete spill file", async () => {
  const result = await executeSearchProcess({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("line\\n".repeat(3000))'],
    cwd: process.cwd(),
    tempPrefix: "pi-search-test-",
  });
  const formatted = formatCapturedOutput(result.output);

  assert.equal(result.code, 0);
  assert.equal(formatted.lineCount, 3000);
  assert.equal(formatted.truncated, true);
  assert.match(formatted.text, /2000 of 3000 lines/);
  assert.ok(formatted.fullOutputPath);
  assert.equal(
    await readFile(formatted.fullOutputPath, "utf8"),
    "line\n".repeat(3000),
  );
  await rm(dirname(formatted.fullOutputPath), { recursive: true, force: true });
});

test("small output passes through and oversized output is persisted", async () => {
  const small = await formatOutput("a.ts\nb.ts\n", {
    tempPrefix: "pi-fd-",
    persistFullOutput: () => Promise.reject(new Error("should not persist")),
  });
  assert.deepEqual(small, {
    text: "a.ts\nb.ts",
    lineCount: 2,
    truncated: false,
  });

  const bigOutput = Array.from(
    { length: 3000 },
    (_, index) => `file-${index}.ts`,
  ).join("\n");
  let persisted = "";
  const large = await formatOutput(bigOutput, {
    tempPrefix: "pi-fd-",
    persistFullOutput: async (full) => {
      persisted = full;
      return "/tmp/fake/output.txt";
    },
  });
  assert.equal(large.truncated, true);
  assert.equal(persisted, bigOutput);
  assert.match(large.text, /Output truncated: 2000 of 3000 lines/);
});
