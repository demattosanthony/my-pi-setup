export type DiffRequest =
  | { kind: "working" }
  | { kind: "last-turn" }
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "branch"; base?: string }
  | { kind: "commit"; ref: string }
  | { kind: "pr"; target?: string }
  | { kind: "help" };

export const DIFF_USAGE = [
  "Usage:",
  "  /diff                  Working tree (staged, unstaged, and untracked)",
  "  /diff last             Changes from the latest agent turn",
  "  /diff unstaged         Unstaged tracked changes",
  "  /diff staged           Staged changes",
  "  /diff branch [base]     Branch and working tree vs its merge base",
  "  /diff commit [ref]      One commit (default: HEAD)",
  "  /diff pr [number|url]   Pull request for this branch or target",
].join("\n");

const MODE_ALIASES: Record<string, DiffRequest["kind"]> = {
  all: "working",
  work: "working",
  working: "working",
  last: "last-turn",
  "last-turn": "last-turn",
  turn: "last-turn",
  unstaged: "unstaged",
  staged: "staged",
  branch: "branch",
  commit: "commit",
  pr: "pr",
  help: "help",
};

export const DIFF_COMPLETIONS = [
  {
    value: "working",
    label: "working",
    description: "All working-tree changes",
  },
  { value: "last", label: "last", description: "Latest agent turn" },
  {
    value: "unstaged",
    label: "unstaged",
    description: "Unstaged tracked changes",
  },
  { value: "staged", label: "staged", description: "Staged changes" },
  { value: "branch", label: "branch", description: "Branch vs merge base" },
  { value: "commit", label: "commit", description: "A single commit" },
  { value: "pr", label: "pr", description: "A GitHub pull request" },
] as const;

export function parseDiffRequest(rawArgs: string): DiffRequest {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "working" };

  const rawMode = tokens.shift()!.toLowerCase();
  const kind = MODE_ALIASES[rawMode];
  if (!kind)
    throw new Error(`Unknown diff target: ${rawMode}\n\n${DIFF_USAGE}`);

  switch (kind) {
    case "working":
    case "last-turn":
    case "unstaged":
    case "staged":
    case "help":
      requireNoArguments(kind, tokens);
      return { kind };
    case "branch":
      requireAtMostOneArgument(rawMode, tokens);
      return { kind, base: tokens[0] };
    case "commit":
      requireAtMostOneArgument(rawMode, tokens);
      return { kind, ref: tokens[0] ?? "HEAD" };
    case "pr":
      requireAtMostOneArgument(rawMode, tokens);
      return { kind, target: tokens[0] };
  }
}

function requireNoArguments(kind: string, tokens: string[]): void {
  if (tokens.length > 0) {
    throw new Error(
      `/diff ${kind} does not accept arguments.\n\n${DIFF_USAGE}`,
    );
  }
}

function requireAtMostOneArgument(mode: string, tokens: string[]): void {
  if (tokens.length > 1) {
    throw new Error(`Too many arguments for /diff ${mode}.\n\n${DIFF_USAGE}`);
  }
}
