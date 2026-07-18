import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
  AUDIO_EXTENSIONS,
  buildOutputPlan,
  expandPath,
  isSupportedAudio,
  parseCommandArguments,
  type OutputPlan,
} from "./paths.ts";
import { generateSummaryBody, renderSummaryDocument } from "./summarize.ts";

const MESSAGE_TYPE = "call-notes-result";
const STATUS_ID = "call-notes";
const TRANSCRIBE_SCRIPT = fileURLToPath(
  new URL("../../scripts/transcribe-audio.sh", import.meta.url),
);

interface RecentAudio {
  path: string;
  modifiedAt: Date;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasRecordingsDirectory(cwd: string): Promise<boolean> {
  try {
    return (await stat(join(cwd, "docs", "recordings"))).isDirectory();
  } catch {
    return false;
  }
}

async function recentDownloadsAudio(limit = 12): Promise<RecentAudio[]> {
  const downloads = join(homedir(), "Downloads");
  const entries = await readdir(downloads, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSupportedAudio(entry.name))
      .map(async (entry): Promise<RecentAudio | undefined> => {
        const path = join(downloads, entry.name);
        try {
          return { path, modifiedAt: (await stat(path)).mtime };
        } catch {
          return undefined;
        }
      }),
  );
  return candidates
    .filter((entry): entry is RecentAudio => entry !== undefined)
    .sort(
      (left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime(),
    )
    .slice(0, limit);
}

function recentLabel(entry: RecentAudio): string {
  return `${basename(entry.path)} — ${entry.modifiedAt.toLocaleString()}`;
}

async function chooseInput(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const recent = await recentDownloadsAudio();
  if (recent.length === 0) {
    ctx.ui.notify("No supported audio files found in ~/Downloads.", "warning");
    return undefined;
  }
  const labels = recent.map(recentLabel);
  const selected = await ctx.ui.select("Choose a recording", labels);
  if (!selected) return undefined;
  return recent[labels.indexOf(selected)]?.path;
}

async function resolveInput(
  requested: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  if (!requested) return chooseInput(ctx);
  if (requested.toLowerCase() !== "latest")
    return expandPath(requested, ctx.cwd);
  const latest = (await recentDownloadsAudio(1))[0];
  if (!latest) {
    ctx.ui.notify("No supported audio files found in ~/Downloads.", "warning");
    return undefined;
  }
  return latest.path;
}

function outputDirectoryPrompt(plan: OutputPlan): string {
  return [
    "Output directory — press Enter to use the default",
    "",
    plan.outputDirectory,
    "",
    "Files created:",
    `• ${basename(plan.audioPath)}`,
    `• ${basename(plan.transcriptPath)}`,
    `• ${basename(plan.subtitlesPath)}`,
    `• ${basename(plan.summaryPath)}`,
  ].join("\n");
}

function planDescription(
  plan: OutputPlan,
  model: { provider: string; id: string },
): string {
  return [
    `Input: ${plan.inputPath}`,
    `Output: ${plan.outputDirectory}`,
    `Summary model: ${model.provider}/${model.id}`,
    "The timestamped transcript will be sent to this model provider.",
    "",
    basename(plan.audioPath),
    basename(plan.transcriptPath),
    basename(plan.subtitlesPath),
    basename(plan.summaryPath),
  ].join("\n");
}

function outputTargets(plan: OutputPlan): string[] {
  const targets = [plan.transcriptPath, plan.subtitlesPath, plan.summaryPath];
  if (resolve(plan.audioPath) !== resolve(plan.inputPath))
    targets.push(plan.audioPath);
  return targets;
}

async function validateOutputTargets(plan: OutputPlan): Promise<void> {
  for (const path of outputTargets(plan)) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Refusing to overwrite a non-regular file: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function existingOutputs(plan: OutputPlan): Promise<string[]> {
  const checks = await Promise.all(
    outputTargets(plan).map(async (path) =>
      (await exists(path)) ? path : undefined,
    ),
  );
  return checks.filter((path): path is string => path !== undefined);
}

function setStatus(ctx: ExtensionCommandContext, text?: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(
    STATUS_ID,
    text ? ctx.ui.theme.fg("accent", `call notes: ${text}`) : undefined,
  );
}

function errorText(stdout: string, stderr: string): string {
  const text = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text;
}

async function audioDuration(
  pi: ExtensionAPI,
  inputPath: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await pi.exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      inputPath,
    ],
    { signal, timeout: 30_000 },
  );
  const seconds = Number.parseFloat(result.stdout.trim());
  if (result.code !== 0 || !Number.isFinite(seconds)) return "Unknown";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

async function publishOutputs(
  entries: Array<{ source: string; destination: string }>,
  stagingDirectory: string,
): Promise<void> {
  const backups: Array<{ backup: string; destination: string }> = [];
  const published: string[] = [];

  try {
    for (const [index, entry] of entries.entries()) {
      if (!(await exists(entry.destination))) continue;
      const backup = join(stagingDirectory, `backup-${index}`);
      await rename(entry.destination, backup);
      backups.push({ backup, destination: entry.destination });
    }
    for (const entry of entries) {
      await rename(entry.source, entry.destination);
      published.push(entry.destination);
    }
  } catch (error) {
    await Promise.all(
      published.map((path) => rm(path, { recursive: true, force: true })),
    );
    for (const entry of backups.reverse()) {
      await rename(entry.backup, entry.destination);
    }
    throw error;
  }
}

async function processCall(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  plan: OutputPlan,
  signal: AbortSignal,
): Promise<void> {
  if (!ctx.model)
    throw new Error("No active model selected. Use /model first.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);
  if (!(await exists(TRANSCRIBE_SCRIPT))) {
    throw new Error(`Transcription helper not found: ${TRANSCRIBE_SCRIPT}`);
  }

  await mkdir(plan.outputDirectory, { recursive: true });
  const tempDirectory = await mkdtemp(
    join(plan.outputDirectory, ".call-notes-staging-"),
  );
  const temporaryTranscript = join(tempDirectory, `${plan.stem}.txt`);
  const temporarySubtitles = join(tempDirectory, `${plan.stem}.srt`);

  try {
    setStatus(ctx, "transcribing");
    const transcription = await pi.exec(
      TRANSCRIBE_SCRIPT,
      [
        "--srt",
        "--prompt",
        `Call recording. ${plan.stem.replaceAll(/[-_]+/g, " ")}`,
        plan.inputPath,
        temporaryTranscript,
      ],
      { cwd: ctx.cwd, signal, timeout: 7_200_000 },
    );
    if (transcription.code !== 0) {
      throw new Error(
        `Transcription failed:\n${errorText(transcription.stdout, transcription.stderr)}`,
      );
    }
    if (
      !(await exists(temporaryTranscript)) ||
      !(await exists(temporarySubtitles))
    ) {
      throw new Error(
        "Transcription finished without producing TXT and SRT files.",
      );
    }

    const [srt, duration] = await Promise.all([
      readFile(temporarySubtitles, "utf8"),
      audioDuration(pi, plan.inputPath, signal),
    ]);
    const body = await generateSummaryBody({
      model: ctx.model,
      auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
      srt,
      signal,
      onPhase: (phase) => setStatus(ctx, phase.replace(/…$/, "")),
    });
    const summary = renderSummaryDocument(plan, duration, body);
    if (signal.aborted) throw new Error("Call-note generation cancelled.");

    setStatus(ctx, "saving files");
    const temporarySummary = join(tempDirectory, `${plan.stem}-summary.md`);
    await writeFile(temporarySummary, summary, "utf8");
    const files = [
      { source: temporaryTranscript, destination: plan.transcriptPath },
      { source: temporarySubtitles, destination: plan.subtitlesPath },
      { source: temporarySummary, destination: plan.summaryPath },
    ];
    if (resolve(plan.audioPath) !== resolve(plan.inputPath)) {
      const temporaryAudio = join(tempDirectory, basename(plan.audioPath));
      await copyFile(plan.inputPath, temporaryAudio);
      files.unshift({ source: temporaryAudio, destination: plan.audioPath });
    }
    if (signal.aborted) throw new Error("Call-note generation cancelled.");
    await publishOutputs(files, tempDirectory);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runCallNotes(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArguments: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/call-notes requires interactive TUI mode.", "error");
    return;
  }
  await ctx.waitForIdle();

  let args;
  try {
    args = parseCommandArguments(rawArguments);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }

  if (!ctx.model) {
    ctx.ui.notify("No active model selected. Use /model first.", "error");
    return;
  }

  let inputPath: string | undefined;
  let plan: OutputPlan;
  try {
    inputPath = await resolveInput(args.input, ctx);
    if (!inputPath) return;
    const projectHasRecordings = await hasRecordingsDirectory(ctx.cwd);

    let requestedOutput = args.output;
    if (!args.input) {
      const defaultPlan = await buildOutputPlan(
        ctx.cwd,
        inputPath,
        undefined,
        projectHasRecordings,
      );
      const selectedOutput = await ctx.ui.input(
        outputDirectoryPrompt(defaultPlan),
        "Type a different directory, or press Enter",
      );
      if (selectedOutput === undefined) return;
      requestedOutput = selectedOutput.trim() || defaultPlan.outputDirectory;
    }

    plan = await buildOutputPlan(
      ctx.cwd,
      inputPath,
      requestedOutput,
      projectHasRecordings,
    );
    await validateOutputTargets(plan);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }

  const confirmed = await ctx.ui.confirm(
    "Create call notes?",
    planDescription(plan, ctx.model),
  );
  if (!confirmed) return;

  const conflicts = await existingOutputs(plan);
  if (conflicts.length > 0) {
    const overwrite = await ctx.ui.confirm(
      "Overwrite existing call-note files?",
      conflicts.map((path) => basename(path)).join("\n"),
    );
    if (!overwrite) return;
  }

  let failure: unknown;
  let completed: boolean | null;
  try {
    completed = await ctx.ui.custom<boolean | null>(
      (tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          "Transcribing and summarizing call…",
        );
        let settled = false;
        const finish = (value: boolean | null) => {
          if (settled) return;
          settled = true;
          loader.dispose();
          done(value);
        };
        loader.onAbort = () => setStatus(ctx, "cancelling");
        processCall(pi, ctx, plan, loader.signal)
          .then(() => finish(true))
          .catch((error) => {
            if (loader.signal.aborted) finish(null);
            else {
              failure = error;
              finish(false);
            }
          });
        return loader;
      },
    );
  } finally {
    setStatus(ctx, undefined);
  }
  if (completed === null) {
    ctx.ui.notify("Call-note generation cancelled.", "info");
    return;
  }
  if (!completed) {
    ctx.ui.notify(
      `Call-note generation failed: ${failure instanceof Error ? failure.message : String(failure ?? "unknown error")}`,
      "error",
    );
    return;
  }

  const result = [
    "Call notes ready:",
    `- ${plan.audioPath}`,
    `- ${plan.transcriptPath}`,
    `- ${plan.subtitlesPath}`,
    `- ${plan.summaryPath}`,
  ].join("\n");
  ctx.ui.notify(`Call notes ready: ${plan.outputDirectory}`, "info");
  pi.sendMessage({ customType: MESSAGE_TYPE, content: result, display: true });
}

export default function callNotesExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    MESSAGE_TYPE,
    (message, _options, theme) =>
      new Text(theme.fg("success", String(message.content ?? "")), 0, 0),
  );

  pi.registerCommand("call-notes", {
    description:
      "Transcribe an audio recording and create concise Markdown call notes",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      if ("latest".startsWith(prefix.trim().toLowerCase())) {
        return [
          {
            value: "latest",
            label: "latest",
            description: "Most recent audio file in ~/Downloads",
          },
        ];
      }
      return null;
    },
    handler: async (args, ctx) => runCallNotes(pi, ctx, args),
  });
}

export { AUDIO_EXTENSIONS };
