import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOutputPlan,
  localDateStamp,
  parseCommandArguments,
  resolveOutputDirectory,
  titleFromStem,
} from "../../extensions/call-notes/paths.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("parseCommandArguments", () => {
  test("accepts latest with an output directory", () => {
    expect(parseCommandArguments("latest docs/recordings")).toEqual({
      input: "latest",
      output: "docs/recordings",
    });
  });

  test("preserves spaces inside quoted paths", () => {
    expect(
      parseCommandArguments(
        '"~/Downloads/customer call.m4a" "docs/client recordings"',
      ),
    ).toEqual({
      input: "~/Downloads/customer call.m4a",
      output: "docs/client recordings",
    });
  });

  test("rejects extra positional arguments", () => {
    expect(() => parseCommandArguments("one two three")).toThrow("Usage:");
  });

  test("rejects unclosed quotes", () => {
    expect(() => parseCommandArguments("'unfinished")).toThrow(
      "Unclosed quote",
    );
  });
});

describe("output planning", () => {
  test("adds a date folder when the explicit destination is recordings", () => {
    expect(
      resolveOutputDirectory(
        "/project",
        "/audio/call.m4a",
        "docs/recordings",
        "2026-07-17",
        false,
      ),
    ).toBe("/project/docs/recordings/2026-07-17");
  });

  test("uses the explicit destination unchanged otherwise", () => {
    expect(
      resolveOutputDirectory(
        "/project",
        "/audio/call.m4a",
        "notes/customer",
        "2026-07-17",
        true,
      ),
    ).toBe("/project/notes/customer");
  });

  test("creates predictable output names from the recording", async () => {
    const root = join(tmpdir(), `call-notes-test-${crypto.randomUUID()}`);
    temporaryPaths.push(root);
    await mkdir(root, { recursive: true });
    const input = join(root, "customer-call.m4a");
    await writeFile(input, "audio");
    const modified = new Date(2026, 6, 17, 12, 0, 0);
    await utimes(input, modified, modified);

    const plan = await buildOutputPlan(root, input, "notes", false);
    expect(plan.date).toBe(localDateStamp(modified));
    expect(plan.audioPath).toBe(join(root, "notes", "customer-call.m4a"));
    expect(plan.transcriptPath).toBe(join(root, "notes", "customer-call.txt"));
    expect(plan.subtitlesPath).toBe(join(root, "notes", "customer-call.srt"));
    expect(plan.summaryPath).toBe(
      join(root, "notes", "customer-call-summary.md"),
    );
  });
});

test("titleFromStem creates a readable title", () => {
  expect(titleFromStem("ECIS-quote-line-item-call")).toBe(
    "ECIS Quote Line Item Call",
  );
});
