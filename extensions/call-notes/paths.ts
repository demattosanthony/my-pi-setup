import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

export const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
]);

export interface CallNotesArguments {
  input?: string;
  output?: string;
}

export interface OutputPlan {
  inputPath: string;
  outputDirectory: string;
  audioPath: string;
  transcriptPath: string;
  subtitlesPath: string;
  summaryPath: string;
  date: string;
  stem: string;
}

export function parseCommandArguments(raw: string): CallNotesArguments {
  const values: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const character of raw.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        values.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in command arguments.");
  if (current) values.push(current);
  if (values.length > 2) {
    throw new Error(
      "Usage: /call-notes [audio-file|latest] [output-directory]",
    );
  }
  return { input: values[0], output: values[1] };
}

export function expandPath(value: string, cwd: string): string {
  const withoutAt = value.startsWith("@") ? value.slice(1) : value;
  if (withoutAt === "~") return homedir();
  if (withoutAt.startsWith("~/")) {
    return resolve(homedir(), withoutAt.slice(2));
  }
  return resolve(cwd, withoutAt);
}

export function isSupportedAudio(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

export function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function titleFromStem(stem: string): string {
  const words = stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  return words
    .map((word, index) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      if (index > 0 && /^(a|an|and|at|for|in|of|on|the|to)$/i.test(word)) {
        return word.toLowerCase();
      }
      return word ? word[0]!.toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

export function defaultOutputDirectory(
  cwd: string,
  inputPath: string,
  date: string,
): string {
  return join(cwd, "docs", "recordings", date);
}

export function resolveOutputDirectory(
  cwd: string,
  inputPath: string,
  requestedOutput: string | undefined,
  date: string,
  projectHasRecordingsDirectory: boolean,
): string {
  if (!requestedOutput) {
    return projectHasRecordingsDirectory
      ? defaultOutputDirectory(cwd, inputPath, date)
      : dirname(inputPath);
  }

  const requested = expandPath(requestedOutput, cwd);
  return basename(requested) === "recordings"
    ? join(requested, date)
    : requested;
}

export async function buildOutputPlan(
  cwd: string,
  inputPath: string,
  requestedOutput: string | undefined,
  projectHasRecordingsDirectory: boolean,
): Promise<OutputPlan> {
  const input = expandPath(inputPath, cwd);
  const inputStats = await stat(input);
  if (!inputStats.isFile()) throw new Error(`Not a file: ${input}`);
  if (!isSupportedAudio(input))
    throw new Error(`Unsupported audio format: ${input}`);

  const date = localDateStamp(inputStats.mtime);
  const extension = extname(input);
  const stem = basename(input, extension);
  const outputDirectory = resolveOutputDirectory(
    cwd,
    input,
    requestedOutput,
    date,
    projectHasRecordingsDirectory,
  );

  return {
    inputPath: input,
    outputDirectory,
    audioPath: join(outputDirectory, `${stem}${extension}`),
    transcriptPath: join(outputDirectory, `${stem}.txt`),
    subtitlesPath: join(outputDirectory, `${stem}.srt`),
    summaryPath: join(outputDirectory, `${stem}-summary.md`),
    date,
    stem,
  };
}
