import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
  findRightPane,
  openDiffInRightPane,
  type CmuxPane,
} from "../../extensions/diff/cmux.ts";
import type { ExecFn } from "../../extensions/diff/patch.ts";

const callerPane: CmuxPane = {
  ref: "pane:left",
  pixel_frame: { x: 0, y: 0, width: 600, height: 800 },
  selected_surface_ref: "surface:chat",
  surface_refs: ["surface:chat"],
};

const rightPane: CmuxPane = {
  ref: "pane:right",
  pixel_frame: { x: 600, y: 0, width: 600, height: 800 },
  selected_surface_ref: "surface:shell",
  surface_refs: ["surface:shell"],
};

describe("findRightPane", () => {
  test("selects the nearest vertically overlapping pane to the right", () => {
    const farther: CmuxPane = {
      ref: "pane:farther",
      pixel_frame: { x: 1_200, y: 0, width: 400, height: 800 },
    };
    expect(findRightPane([farther, rightPane, callerPane], "pane:left")).toBe(
      "pane:right",
    );
  });

  test("ignores panes below or to the left", () => {
    const below: CmuxPane = {
      ref: "pane:below",
      pixel_frame: { x: 0, y: 800, width: 600, height: 400 },
    };
    const left: CmuxPane = {
      ref: "pane:far-left",
      pixel_frame: { x: -600, y: 0, width: 600, height: 800 },
    };
    expect(
      findRightPane([callerPane, below, left], "pane:left"),
    ).toBeUndefined();
  });
});

describe("openDiffInRightPane", () => {
  test("moves the new viewer into an existing right pane as a tab", async () => {
    const calls: string[][] = [];
    const exec = fakeCmux(calls, [callerPane, rightPane]);

    const result = await openDiffInRightPane(
      exec,
      {
        cwd: "/repo",
        title: "Working tree · repo",
        patchPath: "/tmp/changes.patch",
      },
      "cmux",
    );

    expect(result).toEqual({ reusedRightPane: true });
    const diff = calls.find((args) => args[1] === "diff")!;
    expect(diff).toContain("/tmp/changes.patch");
    expect(valueAfter(diff, "--focus")).toBe("false");
    expect(valueAfter(diff, "--surface")).toBe("surface:chat");

    const move = calls.find((args) => args[0] === "move-surface")!;
    expect(valueAfter(move, "--surface")).toBe("surface:diff");
    expect(valueAfter(move, "--pane")).toBe("pane:right");
    expect(valueAfter(move, "--focus")).toBe("true");
  });

  test("lets cmux create and focus a right split when none exists", async () => {
    const calls: string[][] = [];
    const exec = fakeCmux(calls, [callerPane]);

    const result = await openDiffInRightPane(
      exec,
      {
        cwd: "/repo",
        title: "Last turn · repo",
        source: "last-turn",
        sessionId: "session-1",
      },
      "cmux",
    );

    expect(result).toEqual({ reusedRightPane: false });
    const diff = calls.find((args) => args[1] === "diff")!;
    expect(diff).toContain("--last-turn");
    expect(valueAfter(diff, "--session")).toBe("session-1");
    expect(valueAfter(diff, "--focus")).toBe("true");
    expect(calls.some((args) => args[0] === "move-surface")).toBe(false);
  });
});

function fakeCmux(calls: string[][], panes: CmuxPane[]): ExecFn {
  return async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) {
      return result({
        caller: {
          workspace_ref: "workspace:1",
          pane_ref: "pane:left",
          surface_ref: "surface:chat",
        },
      });
    }
    if (args.includes("list-panes")) return result({ panes });
    if (args.includes("diff")) {
      return result({ surface_id: "surface:diff", pane_id: "pane:new" });
    }
    return result({});
  };
}

function result(value: unknown): ExecResult {
  return {
    code: 0,
    stdout: JSON.stringify(value),
    stderr: "",
    killed: false,
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
