import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { CapturedOutput } from "./output.ts";

const STDERR_MAX_BYTES = 64 * 1024;

interface PreviewState {
  readonly decoder: TextDecoder;
  preview: string;
  totalBytes: number;
  lineBreaks: number;
  trailingLineBreaks: number;
  truncated: boolean;
}

function makePreviewState(): PreviewState {
  return {
    decoder: new TextDecoder(),
    preview: "",
    totalBytes: 0,
    lineBreaks: 0,
    trailingLineBreaks: 0,
    truncated: false,
  };
}

function observeStdout(state: PreviewState, chunk: Uint8Array) {
  state.totalBytes += chunk.byteLength;
  for (const byte of chunk) {
    if (byte === 0x0a) {
      state.lineBreaks++;
      state.trailingLineBreaks++;
    } else {
      state.trailingLineBreaks = 0;
    }
  }

  if (state.truncated) return;
  state.preview += state.decoder.decode(chunk, { stream: true });
  const truncation = truncateHead(state.preview, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (truncation.truncated) {
    state.preview = truncation.content;
    state.truncated = true;
  }
}

function finishStdout(state: PreviewState, fullOutputPath: string) {
  if (!state.truncated) state.preview += state.decoder.decode();
  const totalBytes = state.totalBytes - state.trailingLineBreaks;
  const lineCount =
    totalBytes === 0 ? 0 : state.lineBreaks - state.trailingLineBreaks + 1;
  return {
    preview: state.preview,
    lineCount,
    totalBytes,
    truncated: state.truncated,
    fullOutputPath: state.truncated ? fullOutputPath : undefined,
  } satisfies CapturedOutput;
}

async function collectStderr(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const value of stream) {
    if (totalBytes >= STDERR_MAX_BYTES) continue;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const kept = chunk.subarray(0, STDERR_MAX_BYTES - totalBytes);
    chunks.push(kept);
    totalBytes += kept.byteLength;
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== null) resolve(code);
      else
        reject(
          new Error(`search process exited via ${signal ?? "unknown signal"}`),
        );
    });
  });
}

export async function executeSearchProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly tempPrefix: string;
  readonly signal?: AbortSignal;
}) {
  const directory = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const fullOutputPath = join(directory, "output.txt");
  let retainDirectory = false;

  try {
    const preview = makePreviewState();
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const observer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        observeStdout(preview, chunk);
        callback(null, chunk);
      },
    });

    const [code, , stderr] = await Promise.all([
      waitForExit(child),
      pipeline(child.stdout, observer, createWriteStream(fullOutputPath)),
      collectStderr(child.stderr),
    ]);
    const output = finishStdout(preview, fullOutputPath);
    retainDirectory = output.truncated;
    return { code, stderr, output };
  } finally {
    if (!retainDirectory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function discardCapturedOutput(output: CapturedOutput) {
  if (!output.fullOutputPath) return;
  await rm(dirname(output.fullOutputPath), { recursive: true, force: true });
}
