/**
 * Shared types for the code-review extension.
 */

export type Severity = "critical" | "warning" | "info" | "suggestion";

export type Category =
  | "bug"
  | "issue"
  | "simplification"
  | "duplication"
  | "security"
  | "performance"
  | "maintainability"
  | "style"
  | "other";

export interface Finding {
  id: number;
  severity: Severity;
  category: Category;
  file: string;
  /** "42", "42-58", or "" when unknown. */
  lines: string;
  title: string;
  description: string;
  suggestion: string;
}

export interface ReviewResult {
  /** Short overall assessment from the model. */
  summary: string;
  findings: Finding[];
  /** Raw model output, kept for export / debugging. */
  raw: string;
}

export type ReviewSourceKind = "working" | "staged" | "pr";

export interface ReviewSource {
  kind: ReviewSourceKind;
  /** Human readable label, e.g. "Working changes (3 files)". */
  label: string;
  /** The base ref for PR reviews, e.g. "origin/main". */
  base?: string;
  /** Changed files (relative paths). */
  files: string[];
  /** The unified diff text sent to the model. */
  diff: string;
  /** Whether the diff was truncated to fit context limits. */
  truncated: boolean;
}

/** Actions the results browser can return to the orchestrator. */
export type ReviewAction =
  | { action: "close" }
  | { action: "rerun" }
  | { action: "export" }
  | { action: "fix"; finding: Finding };

/** Severity display metadata. */
export interface SeverityMeta {
  icon: string;
  color: "error" | "warning" | "accent" | "muted";
  label: string;
}

export const SEVERITY_ORDER: Severity[] = [
  "critical",
  "warning",
  "info",
  "suggestion",
];

export const SEVERITY_META: Record<Severity, SeverityMeta> = {
  critical: { icon: "✖", color: "error", label: "critical" },
  warning: { icon: "▲", color: "warning", label: "warning" },
  info: { icon: "ℹ", color: "accent", label: "info" },
  suggestion: { icon: "✎", color: "muted", label: "suggestion" },
};

export const CATEGORY_LABELS: Category[] = [
  "bug",
  "issue",
  "simplification",
  "duplication",
  "security",
  "performance",
  "maintainability",
  "style",
  "other",
];
