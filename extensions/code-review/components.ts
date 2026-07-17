/**
 * TUI components for the code-review extension:
 *  - pickOption: a framed SelectList picker (source / base-branch selection)
 *  - ReviewProgress: animated streaming loader shown while the model reviews
 *  - ResultsBrowser: the list + detail-pane findings browser
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  type TUI,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ReviewAction } from "./types.ts";
import {
  SEVERITY_META,
  SEVERITY_ORDER,
  type Finding,
  type ReviewResult,
  type ReviewSource,
  type Severity,
} from "./types.ts";

type Theme = ExtensionCommandContext["ui"]["theme"];

/* ------------------------------------------------------------------ */
/* Generic picker                                                      */
/* ------------------------------------------------------------------ */

export async function pickOption(
  ctx: ExtensionCommandContext,
  title: string,
  help: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(0));

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", theme.bold(t)),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(new Spacer(0));
    container.addChild(new Text(theme.fg("dim", help), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Review progress (streaming loader)                                  */
/* ------------------------------------------------------------------ */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ReviewProgress implements Component {
  private theme: Theme;
  private tui: TUI;
  private title: string;
  private model: string;
  private fileCount: number;
  private startTime: number;

  public preview = "";
  public phase = "Preparing diff…";
  public onCancel?: () => void;

  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    tui: TUI,
    theme: Theme,
    title: string,
    model: string,
    fileCount: number,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.model = model;
    this.fileCount = fileCount;
    this.startTime = Date.now();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, 100);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  invalidate(): void {
    // Stateless render; nothing to clear.
  }

  render(width: number): string[] {
    const th = this.theme;
    const W = width;
    const lines: string[] = [];

    lines.push(rule(th, W, " Code Review "));
    lines.push(
      ` ${th.fg("accent", th.bold("Reviewing"))}${th.fg("dim", "  ·  ")}${th.fg("muted", this.title)}`,
    );

    const spinner = th.fg("accent", SPINNER_FRAMES[this.frame] ?? "·");
    const elapsed = Math.max(
      0,
      Math.floor((Date.now() - this.startTime) / 1000),
    );
    lines.push(` ${spinner} ${th.fg("text", this.phase)}`);
    lines.push(
      ` ${th.fg("dim", `Files: ${this.fileCount}  ·  Model: ${this.model}  ·  ${elapsed}s`)}`,
    );

    lines.push("");
    const previewLines = previewWindow(this.preview, W - 2, 4);
    if (previewLines.length === 0) {
      lines.push(` ${th.fg("dim", "Waiting for model…")}`);
    } else {
      for (const l of previewLines) lines.push(` ${th.fg("dim", l)}`);
    }
    lines.push("");
    lines.push(` ${th.fg("dim", "Esc to cancel")}`);

    return lines;
  }
}

function previewWindow(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  if (!text.trim()) return [];
  const tail = text.slice(-2000);
  const wrapped = wrapTextWithAnsi(tail, Math.max(1, width));
  return wrapped
    .map((l) => stripAnsi(l))
    .filter((l) => l.trim().length > 0)
    .slice(-maxLines);
}

/* ------------------------------------------------------------------ */
/* Results browser                                                     */
/* ------------------------------------------------------------------ */

type Filter = "all" | Severity;

export class ResultsBrowser implements Component {
  private theme: Theme;
  private tui: TUI;
  private result: ReviewResult;
  private source: ReviewSource;
  private model: string;

  private findings: Finding[];
  private filtered: Finding[];
  private selected = 0;
  private top = 0;
  private detailOffset = 0;
  private filter: Filter = "all";

  private cachedWidth?: number;
  private cachedLines?: string[];

  public onAction?: (action: ReviewAction) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    result: ReviewResult,
    source: ReviewSource,
    model: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.result = result;
    this.source = source;
    this.model = model;
    this.findings = result.findings;
    this.filtered = this.findings;
  }

  private recomputeFilter(): void {
    this.filtered =
      this.filter === "all"
        ? this.findings
        : this.findings.filter((f) => f.severity === this.filter);
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.filtered.length - 1),
    );
    this.detailOffset = 0;
    this.clampViewport();
  }

  private clampViewport(): void {
    const listH = this.listHeight();
    if (this.filtered.length === 0) {
      this.top = 0;
      return;
    }
    if (this.selected < this.top) this.top = this.selected;
    if (this.selected >= this.top + listH) this.top = this.selected - listH + 1;
    const maxTop = Math.max(0, this.filtered.length - listH);
    this.top = Math.max(0, Math.min(this.top, maxTop));
  }

  private rows(): number {
    return Math.max(8, this.tui.terminal.rows);
  }

  private budget(): number {
    return Math.max(14, Math.floor(this.rows() * 0.55));
  }

  private middleHeight(): number {
    return Math.max(6, this.budget() - 6);
  }

  private detailHeight(): number {
    return Math.min(12, Math.max(4, Math.round(this.middleHeight() * 0.45)));
  }

  private listHeight(): number {
    return Math.max(3, this.middleHeight() - this.detailHeight());
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const n = this.filtered.length;

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q"
    ) {
      this.onAction?.({ action: "close" });
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (n) this.selected = (this.selected - 1 + n) % n;
      this.detailOffset = 0;
      this.clampViewport();
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (n) this.selected = (this.selected + 1) % n;
      this.detailOffset = 0;
      this.clampViewport();
    } else if (data === "g") {
      this.selected = 0;
      this.detailOffset = 0;
      this.clampViewport();
    } else if (data === "G") {
      this.selected = Math.max(0, n - 1);
      this.detailOffset = 0;
      this.clampViewport();
    } else if (matchesKey(data, Key.tab)) {
      this.cycleFilter();
    } else if (data === "0") {
      this.setFilter("all");
    } else if (data === "1") {
      this.setFilter("critical");
    } else if (data === "2") {
      this.setFilter("warning");
    } else if (data === "3") {
      this.setFilter("info");
    } else if (data === "4") {
      this.setFilter("suggestion");
    } else if (matchesKey(data, Key.enter) || data === "f") {
      const f = this.filtered[this.selected];
      if (f) this.onAction?.({ action: "fix", finding: f });
    } else if (data === "e") {
      this.onAction?.({ action: "export" });
    } else if (data === "r") {
      this.onAction?.({ action: "rerun" });
    } else if (data === "J") {
      this.detailOffset = Math.min(50, this.detailOffset + 1);
    } else if (data === "K") {
      this.detailOffset = Math.max(0, this.detailOffset - 1);
    } else {
      return;
    }
    this.requestRender();
  }

  private cycleFilter(): void {
    const order: Filter[] = ["all", ...SEVERITY_ORDER];
    const idx = order.indexOf(this.filter);
    this.filter = order[(idx + 1) % order.length] ?? "all";
    this.recomputeFilter();
  }

  private setFilter(f: Filter): void {
    this.filter = f;
    this.recomputeFilter();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const W = width;
    const lines: string[] = [];

    // ---- Header ----
    lines.push(rule(th, W, " Code Review "));
    const titleParts =
      ` ${th.fg("accent", th.bold("Findings"))}` +
      `${th.fg("dim", "  ·  ")}` +
      `${th.fg("muted", this.source.label)}` +
      `${th.fg("dim", "  ·  ")}` +
      `${th.fg("muted", this.model)}`;
    lines.push(truncateToWidth(titleParts, W));

    lines.push(truncateToWidth(" " + this.renderCounts(), W, ""));
    lines.push(
      truncateToWidth(
        ` ${th.fg("dim", "Filter:")} ${this.renderFilter()}${th.fg("dim", `   ${this.filtered.length}/${this.findings.length} shown`)}`,
        W,
        "",
      ),
    );

    // ---- List ----
    const listH = this.listHeight();
    for (let row = 0; row < listH; row++) {
      const idx = this.top + row;
      if (idx >= this.filtered.length) {
        lines.push("");
        continue;
      }
      lines.push(
        this.renderFindingRow(this.filtered[idx], idx === this.selected, W),
      );
    }

    // ---- Separator ----
    lines.push(th.fg("borderMuted", "─".repeat(W)));

    // ---- Detail ----
    for (const l of this.renderDetail(W)) lines.push(l);

    // ---- Footer ----
    const fullHint =
      "↑↓/jk move  Tab/0-4 filter  g/G top/bot  f/Enter fix  e export  r rerun  q quit";
    const shortHint = "↑↓ move · f fix · e export · r rerun · q quit";
    const hint = W < 64 ? shortHint : fullHint;
    lines.push(truncateToWidth(` ${th.fg("dim", hint)}`, W, ""));

    this.cachedWidth = W;
    this.cachedLines = lines;
    return lines;
  }

  private renderCounts(): string {
    const th = this.theme;
    const counts: Record<Severity, number> = {
      critical: 0,
      warning: 0,
      info: 0,
      suggestion: 0,
    };
    for (const f of this.findings) counts[f.severity]++;
    const parts: string[] = [];
    for (const sev of SEVERITY_ORDER) {
      const meta = SEVERITY_META[sev];
      parts.push(
        `${th.fg(meta.color, `${meta.icon} ${counts[sev]}`)}${th.fg("dim", ` ${meta.label}`)}`,
      );
    }
    return parts.join(th.fg("dim", "   "));
  }

  private renderFilter(): string {
    const th = this.theme;
    if (this.filter === "all") return th.fg("accent", "all");
    const meta = SEVERITY_META[this.filter];
    return th.fg(meta.color, `${meta.icon} ${meta.label}`);
  }

  private renderFindingRow(f: Finding, selected: boolean, W: number): string {
    const th = this.theme;
    const meta = SEVERITY_META[f.severity];
    const marker = selected ? th.fg("accent", "▶ ") : "  ";
    const icon = th.fg(meta.color, meta.icon);
    const cat = padVis(f.category, 14);
    const catColored = selected ? th.fg("accent", cat) : th.fg("muted", cat);
    const loc = `${f.file}${f.lines ? `:${f.lines}` : ""}`;
    const locWidth = Math.min(
      visibleWidth(loc),
      Math.max(10, Math.floor(W * 0.32)),
    );
    const locTrunc = truncateToWidth(loc, locWidth, "…");
    const locField = selected
      ? th.fg("accent", locTrunc)
      : th.fg("dim", locTrunc);
    const titleColored = selected
      ? th.fg("accent", th.bold(f.title))
      : th.fg("text", f.title);

    const left = ` ${marker}${icon} ${catColored} `;
    const right = ` ${titleColored}`;
    const gap = Math.max(
      1,
      W - visibleWidth(left) - visibleWidth(locTrunc) - visibleWidth(right),
    );
    return truncateToWidth(
      `${left}${locField}${" ".repeat(gap)}${right}`,
      W,
      "",
    );
  }

  private renderDetail(W: number): string[] {
    const th = this.theme;
    const detailH = this.detailHeight();
    const innerW = Math.max(1, W - 2);
    const f = this.filtered[this.selected];

    if (!f) {
      const out: string[] = [];
      if (this.findings.length === 0) {
        out.push(` ${th.fg("muted", "Summary")}`);
        const summary = this.result.summary || "No findings.";
        for (const l of wrapTextWithAnsi(th.fg("text", summary), innerW))
          out.push(` ${l}`);
      } else {
        out.push(` ${th.fg("warning", "⚠ No findings match this filter.")}`);
      }
      while (out.length < detailH) out.push("");
      return out;
    }

    const meta = SEVERITY_META[f.severity];
    const lines: string[] = [];

    lines.push(
      truncateToWidth(
        ` ${th.fg(meta.color, meta.icon)} ${th.fg("accent", th.bold(f.title))}`,
        W,
        "…",
      ),
    );

    const loc = `${th.fg("dim", "File:")} ${th.fg("muted", f.file)}${f.lines ? th.fg("dim", ":") + th.fg("accent", f.lines) : ""}`;
    const tags = `${th.fg(meta.color, meta.label)}${th.fg("dim", " · ")}${th.fg("muted", f.category)}`;
    lines.push(truncateToWidth(` ${loc}   ${tags}`, W, "…"));

    lines.push("");
    for (const l of wrapTextWithAnsi(
      th.fg("text", f.description || "(no description)"),
      innerW,
    ))
      lines.push(` ${l}`);

    if (f.suggestion) {
      lines.push("");
      const sug = `${th.fg("muted", "Suggestion:")} ${th.fg("text", f.suggestion)}`;
      for (const l of wrapTextWithAnsi(sug, innerW)) lines.push(` ${l}`);
    }

    const scrolled = lines.slice(this.detailOffset);
    const out = scrolled.slice(0, detailH);
    if (scrolled.length > detailH) {
      out[detailH - 1] = ` ${th.fg("dim", "… (J/K to scroll detail)")}`;
    }
    while (out.length < detailH) out.push("");
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Small render helpers                                                */
/* ------------------------------------------------------------------ */

function rule(theme: Theme, width: number, title: string): string {
  const W = Math.max(1, width);
  const titleW = visibleWidth(title);
  if (titleW + 2 >= W) return theme.fg("accent", "─".repeat(W));
  const dashCount = Math.max(0, W - titleW);
  const left = Math.floor(dashCount / 2);
  const right = dashCount - left;
  return (
    theme.fg("accent", "─".repeat(left)) +
    theme.fg("accent", theme.bold(title)) +
    theme.fg("accent", "─".repeat(right))
  );
}

function padVis(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/** Strip ANSI escape sequences for width math / preview filtering. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
