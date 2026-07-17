/**
 * The review engine: builds the review prompt, streams the model response,
 * and defensively parses the structured findings out of the output.
 */

import { stream, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type {
  Finding,
  ReviewResult,
  ReviewSource,
  Severity,
  Category,
} from "./types.ts";
import { CATEGORY_LABELS, SEVERITY_META } from "./types.ts";

export interface ModelAuth {
  apiKey: string;
  headers: Record<string, string>;
  env?: Record<string, string>;
}

const REVIEW_SYSTEM_PROMPT = `You are a meticulous senior software engineer performing a code review. You review diffs for real problems, not style nitpicks.

Focus on, in priority order:
- Bugs: logic errors, null/undefined mishandling, off-by-one, race conditions, incorrect error handling, resource leaks, broken contracts.
- Issues: correctness risks, edge cases, missing validation, fragile assumptions.
- Security: injection, authn/authz, secret handling, path traversal, unsafe deserialization.
- Simplifications: overly complex code that can be clearer or shorter without changing behavior.
- Duplication: copy-pasted logic that should be extracted.
- Performance: wasteful work, N+1 queries, unnecessary allocations.
- Maintainability: unclear naming, missing context, hard-to-test code.

For each finding be concrete and actionable: reference the file and line range, explain the problem, and propose a fix. Skip trivial formatting nits unless they harm readability. Only report issues you are reasonably confident about; do not invent problems.

Output ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "summary": "one or two sentence overall assessment",
  "findings": [
    {
      "severity": "critical" | "warning" | "info" | "suggestion",
      "category": "bug" | "issue" | "simplification" | "duplication" | "security" | "performance" | "maintainability" | "style" | "other",
      "file": "relative/path.ext",
      "lines": "42" or "42-58",
      "title": "short one-line summary",
      "description": "what is wrong and why it matters",
      "suggestion": "concrete recommended fix"
    }
  ]
}

If there are no real issues, return { "summary": "...", "findings": [] }.`;

function buildUserPrompt(source: ReviewSource): string {
  const fileList =
    source.files.length > 0
      ? source.files.map((f) => `  - ${f}`).join("\n")
      : "  (none)";
  const truncationNote = source.truncated
    ? "\nNOTE: The diff was truncated to fit context limits. Only review the shown portion."
    : "";
  return [
    `Review the following changes.${truncationNote}`,
    "",
    `Changed files (${source.files.length}):`,
    fileList,
    "",
    "Diff:",
    source.diff || "(empty diff)",
    "",
    "Return the JSON object now.",
  ].join("\n");
}

/** Extract joined text from a streamed assistant message (tolerant of shape). */
function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("");
}

/**
 * Stream the review. Returns the final model text, or null if aborted.
 * `onDelta` receives incremental text for a live preview.
 */
export async function runReviewStream(
  model: Model<Api>,
  auth: ModelAuth,
  source: ReviewSource,
  options: {
    signal?: AbortSignal;
    reasoning?: string;
    onDelta?: (chunk: string) => void;
  } = {},
): Promise<string | null> {
  const context = {
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: buildUserPrompt(source) }],
        timestamp: Date.now(),
      },
    ],
  };

  const streamOptions: Record<string, unknown> = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    ...(auth.env ? { env: auth.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  };

  let text = "";
  let finalMessage: unknown;
  const eventStream = stream(model, context, streamOptions);
  try {
    for await (const ev of eventStream) {
      if (options.signal?.aborted) break;
      if (ev.type === "text_delta") {
        text += ev.delta;
        options.onDelta?.(ev.delta);
      } else if (ev.type === "done") {
        finalMessage = ev.message;
      } else if (ev.type === "error") {
        if (ev.reason === "aborted") return null;
        const reason =
          (ev.error as { stopReason?: string } | undefined)?.stopReason ??
          ev.reason;
        throw new Error(`Review stream error: ${reason}`);
      }
    }
  } catch (err) {
    if (options.signal?.aborted) return null;
    throw err;
  }
  if (options.signal?.aborted) return null;
  return extractText(finalMessage) || text;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "critical",
  crit: "critical",
  high: "critical",
  error: "critical",
  fatal: "critical",
  warning: "warning",
  warn: "warning",
  medium: "warning",
  minor: "info",
  info: "info",
  information: "info",
  notice: "info",
  low: "suggestion",
  suggestion: "suggestion",
  suggest: "suggestion",
  improvement: "suggestion",
  nitpick: "suggestion",
  style: "suggestion",
};

const CATEGORY_ALIASES: Record<string, Category> = {
  bug: "bug",
  defect: "bug",
  issue: "issue",
  simplification: "simplification",
  simplify: "simplification",
  complexity: "simplification",
  duplication: "duplication",
  duplicate: "duplication",
  security: "security",
  performance: "performance",
  perf: "performance",
  maintainability: "maintainability",
  maintain: "maintainability",
  style: "style",
  other: "other",
};

function normalizeSeverity(value: unknown): Severity {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  return SEVERITY_ALIASES[key] ?? "info";
}

function normalizeCategory(value: unknown): Category {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  return CATEGORY_ALIASES[key] ?? "other";
}

function asString(value: unknown, max: number): string {
  const s =
    typeof value === "string" ? value : value == null ? "" : String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Extract the first balanced JSON object from a possibly noisy string. */
function extractJsonObject(raw: string): string | null {
  let start = raw.indexOf("{");
  if (start === -1) return null;
  // Prefer a fenced block if present.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{")) return inner;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseReview(raw: string): ReviewResult {
  const jsonText = extractJsonObject(raw);
  let parsed: unknown = null;
  if (jsonText) {
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      summary: "Could not parse structured findings from the model output.",
      findings: [],
      raw,
    };
  }

  const obj = parsed as { summary?: unknown; findings?: unknown };
  const summary = asString(obj.summary, 500);
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];

  const findings: Finding[] = rawFindings
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f, index) => {
      const severity = normalizeSeverity(f.severity);
      return {
        id: index + 1,
        severity,
        category: normalizeCategory(f.category),
        file:
          asString(f.file ?? f.path ?? f.file_path, 300) || "(unknown file)",
        lines: asString(f.lines ?? f.line ?? f.line_range, 40),
        title: asString(f.title ?? f.summary ?? "Untitled finding", 200),
        description: asString(f.description ?? f.problem ?? f.detail, 2000),
        suggestion: asString(
          f.suggestion ?? f.fix ?? f.recommendation ?? "",
          2000,
        ),
      };
    });

  return { summary, findings, raw };
}

/** Markdown export of a review result. */
export function renderReviewMarkdown(
  result: ReviewResult,
  source: ReviewSource,
): string {
  const lines: string[] = [];
  lines.push("# Code Review");
  lines.push("");
  lines.push(`- **Source:** ${source.label}`);
  lines.push(`- **Files:** ${source.files.length}`);
  if (source.base) lines.push(`- **Base:** ${source.base}`);
  lines.push(`- **Findings:** ${result.findings.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(result.summary || "(no summary)");
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("_No findings._");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const f of result.findings) {
      const meta = SEVERITY_META[f.severity];
      lines.push(`### ${meta.icon} ${f.title}`);
      lines.push("");
      lines.push(`- **Severity:** ${f.severity}`);
      lines.push(`- **Category:** ${f.category}`);
      lines.push(
        `- **Location:** \`${f.file}\`${f.lines ? `:${f.lines}` : ""}`,
      );
      lines.push("");
      lines.push(f.description);
      if (f.suggestion) {
        lines.push("");
        lines.push("**Suggested fix:**");
        lines.push("");
        lines.push(f.suggestion);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export { CATEGORY_LABELS };
