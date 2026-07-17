import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  buildFdArgs,
  buildRgArgs,
  FD_MAX_DEPTH_LIMIT,
  FD_MAX_LIMIT,
  RG_MAX_CONTEXT,
  RG_MAX_COUNT_LIMIT,
} from "./src/args.ts";
import {
  currentTarget,
  liveBinaryEnv,
  repositoryBinDir,
  resolveBinary,
  TOOL_SPECS,
  type BinaryEnv,
  type BinarySource,
  type PlatformTarget,
  type ResolvedBinary,
} from "./src/binaries.ts";
import { formatCapturedOutput, type CapturedOutput } from "./src/output.ts";
import {
  FD_PARAMETER_DESCRIPTIONS,
  FD_PROMPT_GUIDELINES,
  FD_PROMPT_SNIPPET,
  FD_TOOL_DESCRIPTION,
  RG_PARAMETER_DESCRIPTIONS,
  RG_PROMPT_GUIDELINES,
  RG_PROMPT_SNIPPET,
  RG_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { discardCapturedOutput, executeSearchProcess } from "./src/process.ts";

export function makeBinaryInitializers(
  binDir: string,
  target: PlatformTarget,
  env: BinaryEnv,
) {
  return {
    fd: resolveBinary(TOOL_SPECS.fd, binDir, target, env),
    rg: resolveBinary(TOOL_SPECS.rg, binDir, target, env),
  };
}

export function installNotifications(binaries: readonly ResolvedBinary[]) {
  return binaries
    .filter((binary) => binary.source === "installed")
    .map(
      (binary) =>
        `file-search: no system ${binary.tool} found — downloaded ${binary.tool} ${binary.version ?? ""}`.trimEnd() +
        ` to ${repositoryBinDir()}`,
    );
}

interface SearchOutcome {
  readonly output: CapturedOutput;
  readonly noMatches: boolean;
  readonly binarySource: BinarySource;
}

export interface FdToolDetails {
  readonly binarySource: BinarySource;
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface RgToolDetails {
  readonly binarySource: BinarySource;
  readonly outputLines: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

const EXEC_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function fileSearchTools(pi: ExtensionAPI) {
  let notified = false;
  const initializers = makeBinaryInitializers(
    repositoryBinDir(),
    currentTarget(),
    liveBinaryEnv,
  );

  pi.on("session_start", async (_event, ctx) => {
    const initialized = await Promise.allSettled([
      initializers.fd,
      initializers.rg,
    ]);
    if (!ctx.hasUI || notified) return;

    notified = true;
    for (const [index, tool] of (["fd", "rg"] as const).entries()) {
      const result = initialized[index]!;
      if (result.status === "fulfilled") {
        for (const message of installNotifications([result.value])) {
          ctx.ui.notify(message, "info");
        }
      } else {
        ctx.ui.notify(
          `file-search ${tool} setup failed: ${errorMessage(result.reason)}`,
          "error",
        );
      }
    }
  });

  async function runSearch(
    tool: "fd" | "rg",
    args: string[],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<SearchOutcome> {
    const binary = await initializers[tool];
    const timeoutSignal = AbortSignal.timeout(EXEC_TIMEOUT_MS);
    const executionSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let result: Awaited<ReturnType<typeof executeSearchProcess>>;
    try {
      result = await executeSearchProcess({
        command: binary.command,
        args,
        cwd: ctx.cwd,
        tempPrefix: `pi-${tool}-`,
        signal: executionSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error(`${tool} search was cancelled.`);
      if (timeoutSignal.aborted) throw new Error(`${tool} timed out.`);
      throw new Error(`${tool} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    if (tool === "rg" && result.code === 1 && result.output.lineCount === 0) {
      return {
        output: result.output,
        noMatches: true,
        binarySource: binary.source,
      };
    }
    if (result.code !== 0) {
      await discardCapturedOutput(result.output);
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`${tool} failed: ${detail}`);
    }
    return {
      output: result.output,
      noMatches: result.output.lineCount === 0,
      binarySource: binary.source,
    };
  }

  pi.registerTool<ReturnType<typeof fdParameters>, FdToolDetails>({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch("fd", buildFdArgs(params), ctx, signal);
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: {
            binarySource: outcome.binarySource,
            matchCount: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<FdToolDetails>;
      }

      const formatted = formatCapturedOutput(outcome.output);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          matchCount: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<FdToolDetails>;
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fd "));
      text += theme.fg("accent", args.pattern ? `"${args.pattern}"` : "(all)");
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.type && `type=${args.type}`,
        args.extension && `ext=${args.extension}`,
        args.glob && "glob",
        args.hidden && "hidden",
        args.max_depth !== undefined && `depth≤${args.max_depth}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += ` ${theme.fg("dim", flags.join(" "))}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.matchCount === 0) {
        return new Text(theme.fg("dim", "No files found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.matchCount} ${details.matchCount === 1 ? "entry" : "entries"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof rgParameters>, RgToolDetails>({
    name: "rg",
    label: "Search Content",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: rgParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch("rg", buildRgArgs(params), ctx, signal);
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: {
            binarySource: outcome.binarySource,
            outputLines: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<RgToolDetails>;
      }

      const formatted = formatCapturedOutput(outcome.output);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          outputLines: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<RgToolDetails>;
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("rg "));
      text += theme.fg("accent", `"${args.pattern}"`);
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.glob && `glob=${args.glob}`,
        args.file_type && `type=${args.file_type}`,
        args.fixed_strings && "literal",
        args.hidden && "hidden",
        args.context !== undefined && `ctx=${args.context}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += ` ${theme.fg("dim", flags.join(" "))}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.outputLines === 0) {
        return new Text(theme.fg("dim", "No matches found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.outputLines} output ${details.outputLines === 1 ? "line" : "lines"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });
}

const PREVIEW_LINES = 20;

interface ThemeLike {
  fg(color: string, text: string): string;
}

function expandedPreview(
  result: { content: { type: string; text?: string }[] },
  fullOutputPath: string | undefined,
  theme: ThemeLike,
) {
  let text = "";
  const content = result.content[0];
  if (content?.type === "text" && content.text) {
    const lines = content.text.split("\n");
    for (const line of lines.slice(0, PREVIEW_LINES)) {
      text += `\n${theme.fg("dim", line)}`;
    }
    if (lines.length > PREVIEW_LINES) {
      text += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
    }
  }
  if (fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${fullOutputPath}`)}`;
  }
  return text;
}

function fdParameters() {
  return Type.Object({
    pattern: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.pattern }),
    ),
    path: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.path }),
    ),
    type: Type.Optional(
      StringEnum(["file", "directory", "symlink"] as const, {
        description: FD_PARAMETER_DESCRIPTIONS.type,
      }),
    ),
    extension: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.extension }),
    ),
    glob: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.glob }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    max_depth: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.max_depth,
        minimum: 1,
        maximum: FD_MAX_DEPTH_LIMIT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: FD_MAX_LIMIT,
      }),
    ),
  });
}

function rgParameters() {
  return Type.Object({
    pattern: Type.String({ description: RG_PARAMETER_DESCRIPTIONS.pattern }),
    path: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.path }),
    ),
    glob: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.glob }),
    ),
    file_type: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.file_type }),
    ),
    case_sensitive: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.case_sensitive }),
    ),
    fixed_strings: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.fixed_strings }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    context: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.context,
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: RG_MAX_COUNT_LIMIT,
      }),
    ),
  });
}
