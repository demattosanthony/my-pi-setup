import { describe, expect, test } from "bun:test";
import {
  renderSummaryDocument,
  splitSrt,
} from "../../extensions/call-notes/summarize.ts";
import type { OutputPlan } from "../../extensions/call-notes/paths.ts";

const plan: OutputPlan = {
  inputPath: "/Downloads/customer-call.m4a",
  outputDirectory: "/project/docs/recordings/2026-07-17",
  audioPath: "/project/docs/recordings/2026-07-17/customer-call.m4a",
  transcriptPath: "/project/docs/recordings/2026-07-17/customer-call.txt",
  subtitlesPath: "/project/docs/recordings/2026-07-17/customer-call.srt",
  summaryPath: "/project/docs/recordings/2026-07-17/customer-call-summary.md",
  date: "2026-07-17",
  stem: "customer-call",
};

describe("splitSrt", () => {
  test("splits only between subtitle blocks", () => {
    const first = "1\n00:00:00,000 --> 00:00:01,000\nFirst line";
    const second = "2\n00:00:01,000 --> 00:00:02,000\nSecond line";
    expect(splitSrt(`${first}\n\n${second}`, first.length + 2)).toEqual([
      first,
      second,
    ]);
  });
});

describe("renderSummaryDocument", () => {
  test("adds metadata and transcript links around the generated body", () => {
    const markdown = renderSummaryDocument(
      plan,
      "6:42",
      "## Outcome\n\nThe catalog needs cleanup.",
    );
    expect(markdown).toContain("# Customer Call");
    expect(markdown).toContain("- **Date:** 2026-07-17");
    expect(markdown).toContain("- **Duration:** 6:42");
    expect(markdown).toContain("[customer-call.txt](customer-call.txt)");
    expect(markdown).toContain("## Outcome\n\nThe catalog needs cleanup.");
    expect(markdown).toContain("## Transcript note");
  });

  test("removes an accidental fenced wrapper and title", () => {
    const markdown = renderSummaryDocument(
      plan,
      "1:00",
      "```markdown\n# Wrong title\n\n## Decisions\n\n- Keep it simple.\n```",
    );
    expect(markdown).not.toContain("Wrong title");
    expect(markdown).toContain("## Decisions\n\n- Keep it simple.");
  });
});
