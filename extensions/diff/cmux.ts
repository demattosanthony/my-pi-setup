import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ExecFn } from "./patch.ts";

const CMUX_TIMEOUT_MS = 60_000;
const GEOMETRY_TOLERANCE = 2;

type Frame = { x: number; y: number; width: number; height: number };

export interface CmuxPane {
  ref?: string;
  pixel_frame?: Frame;
  selected_surface_ref?: string;
  surface_refs?: string[];
}

interface IdentifyResponse {
  caller?: {
    workspace_ref?: string;
    pane_ref?: string;
    surface_ref?: string;
  };
}

interface ListPanesResponse {
  panes?: CmuxPane[];
}

interface DiffResponse {
  surface_id?: string;
  surface_ref?: string;
}

export interface OpenDiffOptions {
  cwd: string;
  title: string;
  source?: "last-turn" | "unstaged" | "staged" | "branch";
  base?: string;
  sessionId?: string;
  patchPath?: string;
}

export interface OpenDiffResult {
  reusedRightPane: boolean;
  warning?: string;
}

export async function openDiffInRightPane(
  exec: ExecFn,
  options: OpenDiffOptions,
  cmuxCommand = process.env.CMUX_BUNDLED_CLI_PATH?.trim() || "cmux",
): Promise<OpenDiffResult> {
  const caller = await identifyCaller(exec, cmuxCommand, options.cwd);
  const panesBefore = await listPanes(
    exec,
    cmuxCommand,
    caller.workspaceRef,
    options.cwd,
  );
  const rightPane = findRightPane(panesBefore, caller.paneRef);

  const diffArgs = buildDiffArgs(options, caller, rightPane === undefined);
  const opened = await runCmux(
    exec,
    cmuxCommand,
    diffArgs,
    options.cwd,
    CMUX_TIMEOUT_MS,
  );
  if (!rightPane) return { reusedRightPane: false };

  const response = parseJson<DiffResponse>(opened.stdout);
  const newSurface =
    response?.surface_ref ??
    response?.surface_id ??
    findNewSurface(
      panesBefore,
      await listPanes(exec, cmuxCommand, caller.workspaceRef, options.cwd),
    );
  if (!newSurface) {
    return {
      reusedRightPane: false,
      warning:
        "The diff opened, but its new cmux surface could not be identified for tab reuse.",
    };
  }

  const moved = await exec(
    cmuxCommand,
    [
      "move-surface",
      "--surface",
      newSurface,
      "--pane",
      rightPane,
      "--workspace",
      caller.workspaceRef,
      "--focus",
      "true",
    ],
    { cwd: options.cwd, timeout: CMUX_TIMEOUT_MS },
  );
  if (moved.code !== 0 || moved.killed) {
    return {
      reusedRightPane: false,
      warning: `The diff opened in a new right pane because the existing pane could not be reused: ${resultError(moved)}`,
    };
  }

  return { reusedRightPane: true };
}

export function findRightPane(
  panes: CmuxPane[],
  callerPaneRef: string,
): string | undefined {
  const caller = panes.find((pane) => pane.ref === callerPaneRef);
  const frame = caller?.pixel_frame;
  if (!frame) return undefined;

  const callerRight = frame.x + frame.width;
  return panes
    .filter((pane): pane is CmuxPane & { ref: string; pixel_frame: Frame } =>
      Boolean(pane.ref && pane.ref !== callerPaneRef && pane.pixel_frame),
    )
    .map((pane) => {
      const candidate = pane.pixel_frame;
      const overlap =
        Math.min(frame.y + frame.height, candidate.y + candidate.height) -
        Math.max(frame.y, candidate.y);
      return {
        ref: pane.ref,
        gap: candidate.x - callerRight,
        overlap,
      };
    })
    .filter(
      (pane) =>
        pane.gap >= -GEOMETRY_TOLERANCE && pane.overlap > GEOMETRY_TOLERANCE,
    )
    .sort(
      (left, right) => left.gap - right.gap || right.overlap - left.overlap,
    )[0]?.ref;
}

function buildDiffArgs(
  options: OpenDiffOptions,
  caller: { workspaceRef: string; surfaceRef: string },
  focus: boolean,
): string[] {
  const args = ["--json", "diff"];
  if (options.patchPath) args.push(options.patchPath);
  if (options.source) args.push(`--${options.source}`);
  args.push(
    "--workspace",
    caller.workspaceRef,
    "--surface",
    caller.surfaceRef,
    "--cwd",
    options.cwd,
    "--title",
    options.title,
    "--focus",
    String(focus),
  );
  if (options.base) args.push("--base", options.base);
  if (options.sessionId) args.push("--session", options.sessionId);
  return args;
}

async function identifyCaller(
  exec: ExecFn,
  cmuxCommand: string,
  cwd: string,
): Promise<{ workspaceRef: string; paneRef: string; surfaceRef: string }> {
  const result = await runCmux(
    exec,
    cmuxCommand,
    ["--json", "identify"],
    cwd,
    5_000,
  );
  const caller = parseJson<IdentifyResponse>(result.stdout)?.caller;
  if (!caller?.workspace_ref || !caller.pane_ref || !caller.surface_ref) {
    throw new Error("/diff must be run from a Pi terminal inside cmux");
  }
  return {
    workspaceRef: caller.workspace_ref,
    paneRef: caller.pane_ref,
    surfaceRef: caller.surface_ref,
  };
}

async function listPanes(
  exec: ExecFn,
  cmuxCommand: string,
  workspaceRef: string,
  cwd: string,
): Promise<CmuxPane[]> {
  const result = await runCmux(
    exec,
    cmuxCommand,
    ["--json", "list-panes", "--workspace", workspaceRef],
    cwd,
    5_000,
  );
  return parseJson<ListPanesResponse>(result.stdout)?.panes ?? [];
}

async function runCmux(
  exec: ExecFn,
  cmuxCommand: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<ExecResult> {
  const result = await exec(cmuxCommand, args, { cwd, timeout });
  if (result.killed)
    throw new Error("cmux timed out while opening the diff viewer");
  if (result.code !== 0) throw new Error(`cmux failed: ${resultError(result)}`);
  return result;
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return undefined;
  }
}

function findNewSurface(
  before: CmuxPane[],
  after: CmuxPane[],
): string | undefined {
  const existing = new Set(before.flatMap((pane) => pane.surface_refs ?? []));
  return after
    .flatMap((pane) => pane.surface_refs ?? [])
    .find((surface) => !existing.has(surface));
}

function resultError(
  result: Pick<ExecResult, "code" | "stdout" | "stderr" | "killed">,
): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.killed ? "command timed out" : `exited with code ${result.code}`)
  );
}
