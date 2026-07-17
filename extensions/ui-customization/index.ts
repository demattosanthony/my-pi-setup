import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Rgb = [number, number, number];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

function sessionCost(ctx: ExtensionContext) {
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }
  return cost;
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

function footerLines(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  width: number,
) {
  const theme = ctx.ui.theme;
  const usage = ctx.getContextUsage();
  const contextPercent =
    usage?.percent === null || usage?.percent === undefined
      ? "?"
      : `${Math.round(usage.percent)}`;
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const context = `${contextPercent}%/${contextWindow ? formatTokens(contextWindow) : "?"}`;
  const model = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id} · ${pi.getThinkingLevel()}`
    : "no model";
  const branch = footerData.getGitBranch();

  const lines = [
    columns(
      theme.fg("text", formatDirectory(ctx.cwd)),
      theme.fg("muted", model),
      width,
    ),
    columns(
      theme.fg("muted", `${context} · $${sessionCost(ctx).toFixed(2)}`),
      theme.fg("muted", branch ?? ""),
      width,
    ),
  ];

  for (const [, text] of [...footerData.getExtensionStatuses()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    for (const line of text.split("\n")) {
      lines.push(truncateToWidth(line, width, theme.fg("dim", "...")));
    }
  }

  return lines;
}

export default function uiCustomization(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const title = formatDirectory(ctx.cwd);
    ctx.ui.setHeader(() => ({
      render(width: number) {
        const art = TITLE_LINES.map((line, row) =>
          center(gradientText(line, row * 0.045), width),
        );
        return [
          "",
          ...art,
          center(`${BOLD}${gradientText(title, 0.18)}${RESET}`, width),
          "",
        ];
      },
      invalidate() {},
    }));

    ctx.ui.setFooter((tui, _theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render: (width: number) => footerLines(pi, ctx, footerData, width),
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
  });
}
