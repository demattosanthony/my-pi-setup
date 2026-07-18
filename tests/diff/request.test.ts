import { describe, expect, test } from "bun:test";
import { parseDiffRequest, DIFF_USAGE } from "../../extensions/diff/request.ts";

describe("parseDiffRequest", () => {
  test("defaults to the complete working tree", () => {
    expect(parseDiffRequest("")).toEqual({ kind: "working" });
  });

  test("accepts concise aliases", () => {
    expect(parseDiffRequest("last")).toEqual({ kind: "last-turn" });
    expect(parseDiffRequest("all")).toEqual({ kind: "working" });
    expect(parseDiffRequest("turn")).toEqual({ kind: "last-turn" });
  });

  test("parses review targets", () => {
    expect(parseDiffRequest("branch origin/main")).toEqual({
      kind: "branch",
      base: "origin/main",
    });
    expect(parseDiffRequest("commit")).toEqual({
      kind: "commit",
      ref: "HEAD",
    });
    expect(parseDiffRequest("commit HEAD~2")).toEqual({
      kind: "commit",
      ref: "HEAD~2",
    });
    expect(parseDiffRequest("pr 42")).toEqual({ kind: "pr", target: "42" });
  });

  test("returns help and explains invalid input", () => {
    expect(parseDiffRequest("help")).toEqual({ kind: "help" });
    expect(() => parseDiffRequest("mystery")).toThrow(DIFF_USAGE);
    expect(() => parseDiffRequest("staged extra")).toThrow(
      "does not accept arguments",
    );
    expect(() => parseDiffRequest("branch main extra")).toThrow(
      "Too many arguments",
    );
  });
});
