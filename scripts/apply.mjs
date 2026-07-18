import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_AGENT_DIR
  ? resolve(process.env.PI_AGENT_DIR)
  : join(homedir(), ".pi", "agent");
const dryRun = process.argv.includes("--dry-run");
const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
const backupDir = join(homedir(), ".pi", "backups", `apply-${stamp}`);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeSettings(current, desired) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(desired)) {
    if (isObject(value) && isObject(current[key])) {
      merged[key] = mergeSettings(current[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw new Error(`Unable to read JSON from ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

function formattedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

let backupCreated = false;
async function ensureBackupDir() {
  if (backupCreated || dryRun) return;
  await mkdir(backupDir, { recursive: true });
  backupCreated = true;
}

async function backup(path) {
  if (!(await exists(path)) || dryRun) return;
  await ensureBackupDir();
  await copyFile(path, join(backupDir, basename(path)));
}

async function writeAtomic(path, content) {
  if (dryRun) return;
  await mkdir(dirname(path), { recursive: true });
  await backup(path);

  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  if (await exists(path)) {
    const currentMode = (await stat(path)).mode;
    await chmod(temporaryPath, currentMode);
  }
  await rename(temporaryPath, path);
}

async function synchronizeJson(source, destination, transform) {
  const sourceValue = await readJson(source);
  const nextValue = transform ? await transform(sourceValue) : sourceValue;
  const nextContent = formattedJson(nextValue);
  const currentContent = (await exists(destination))
    ? await readFile(destination, "utf8")
    : undefined;

  if (currentContent === nextContent) {
    console.log(`unchanged  ${destination}`);
    return false;
  }

  console.log(`${dryRun ? "would update" : "updated  "} ${destination}`);
  await writeAtomic(destination, nextContent);
  return true;
}

if (!dryRun) await mkdir(agentDir, { recursive: true });

const settingsSource = join(repoRoot, "config", "settings.json");
const settingsDestination = join(agentDir, "settings.json");
await synchronizeJson(settingsSource, settingsDestination, async (desired) => {
  const current = await readJson(settingsDestination, {});
  const merged = mergeSettings(current, desired);
  merged.packages = [repoRoot, ...(desired.packages ?? [])];
  return merged;
});

const betterOpenAiDestination = join(
  agentDir,
  "extensions",
  "pi-better-openai.json",
);
await synchronizeJson(
  join(repoRoot, "config", "pi-better-openai.json"),
  betterOpenAiDestination,
  async (desired) =>
    mergeSettings(await readJson(betterOpenAiDestination, {}), desired),
);

const transcribeSource = join(repoRoot, "scripts", "transcribe-audio.sh");
const transcribeDestination = join(
  homedir(),
  ".local",
  "bin",
  "transcribe-audio",
);
const transcribeContent = await readFile(transcribeSource, "utf8");
const installedTranscribeContent = (await exists(transcribeDestination))
  ? await readFile(transcribeDestination, "utf8")
  : undefined;
if (installedTranscribeContent === transcribeContent) {
  console.log(`unchanged  ${transcribeDestination}`);
} else {
  console.log(
    `${dryRun ? "would update" : "updated  "} ${transcribeDestination}`,
  );
  await writeAtomic(transcribeDestination, transcribeContent);
}
if (!dryRun) await chmod(transcribeDestination, 0o755);

if (backupCreated) console.log(`backup    ${backupDir}`);
console.log(
  dryRun
    ? "Dry run complete; no files were changed."
    : "Pi setup applied. Run /reload in Pi, or restart Pi for startup-setting changes.",
);
