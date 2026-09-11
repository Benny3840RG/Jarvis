/**
 * Terminal renderer for the live-work pipeline — the console-native twin of the
 * `src/mcp/dashboard-v1.html` "Live Work" view. Pure: given a `LiveWorkResult`
 * (and a deterministic `now`) it returns the exact string to print, so it is
 * fully testable and the polling loop in `src/tools/runLiveWorkMonitor.ts` stays
 * a thin shell.
 *
 * Same honesty contract as the web HUD: "no mission in flight" is a calm
 * idle panel, a transport/provider fault is a red UNAVAILABLE panel, and a
 * node whose data the domain does not record is shown as such — never faked.
 */

import type {
  LiveWorkNode,
  LiveWorkNodeKey,
  LiveWorkNodeStatus,
  LiveWorkPipeline,
  LiveWorkResult,
} from "./liveWork.js";
import {
  createTerminalStyle,
  padVisible,
  truncateVisible,
  visibleWidth,
  type TerminalStyle,
} from "../terminal/ansi.js";

export interface LiveWorkTerminalOptions {
  /** Total panel width in columns. Clamped to [64, 120]. Default 96. */
  readonly width?: number;
  /** Emit ANSI colour. Default true. */
  readonly color?: boolean;
  /** Clock for the header and event times. Default `new Date()`. */
  readonly now?: Date;
}

const MIN_WIDTH = 64;
const MAX_WIDTH = 120;
const DEFAULT_WIDTH = 96;

const GLYPH: Record<LiveWorkNodeStatus, string> = {
  done: "✔",
  active: "▶",
  pending: "·",
  blocked: "✖",
  unavailable: "?",
};

/** Fixed short labels so the pipeline column stays aligned at 7 columns. */
const NODE_LABEL: Record<LiveWorkNodeKey, string> = {
  mission: "MISSION",
  stage: "STAGE",
  issue: "MISSION",
  pr: "PR",
  worker: "WORKER",
  review: "REVIEW",
  ci: "CI",
  merge: "MERGE",
  omega: "ΩΣ",
};

function paint(style: TerminalStyle, status: LiveWorkNodeStatus, value: string): string {
  switch (status) {
    case "done":
      return style.green(value);
    case "active":
      return style.violet(value);
    case "blocked":
      return style.red(value);
    default:
      return style.grey(value);
  }
}

function clampWidth(width: number | undefined): number {
  const resolved = Math.trunc(width ?? DEFAULT_WIDTH);
  if (Number.isNaN(resolved)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resolved));
}

function isoMinute(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  return `${String(parsed.getUTCHours()).padStart(2, "0")}:${String(
    parsed.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

function stamp(now: Date): string {
  if (Number.isNaN(now.getTime())) return "unknown time";
  return now
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

class Panel {
  private readonly rows: string[] = [];
  /** Printable columns available between the `│ ` and ` │` frame. */
  readonly inner: number;

  constructor(
    private readonly style: TerminalStyle,
    private readonly width: number,
  ) {
    this.inner = width - 4;
  }

  top(title: string): void {
    const ribbon = ` ${title} `;
    const dashes = "─".repeat(Math.max(0, this.width - 2 - visibleWidth(ribbon)));
    this.rows.push(`┌${this.style.bold(this.style.violet(ribbon))}${dashes}┐`);
  }

  rule(label?: string): void {
    if (!label) {
      this.rows.push(`├${"─".repeat(this.width - 2)}┤`);
      return;
    }
    const tag = ` ${label} `;
    const dashes = "─".repeat(Math.max(0, this.width - 2 - visibleWidth(tag)));
    this.rows.push(`├${this.style.grey(tag)}${dashes}┤`);
  }

  blank(): void {
    this.row("");
  }

  /** One framed content row. `left`/`right` may contain SGR escapes. */
  row(left: string, right = ""): void {
    const rightWidth = visibleWidth(right);
    const leftRoom = this.inner - (rightWidth > 0 ? rightWidth + 1 : 0);
    const leftClipped = visibleWidth(left) > leftRoom ? truncateVisible(left, leftRoom) : left;
    const gap = this.inner - visibleWidth(leftClipped) - rightWidth;
    this.rows.push(`│ ${leftClipped}${" ".repeat(Math.max(0, gap))}${right} │`);
  }

  /** `label` column padded to `labelWidth`, then the value; row() clips any overflow. */
  field(label: string, value: string, labelWidth = 12): void {
    this.row(`${this.style.grey(padVisible(label, labelWidth))}${value}`);
  }

  centered(value: string): void {
    const plainWidth = visibleWidth(value);
    const pad = Math.max(0, Math.floor((this.inner - plainWidth) / 2));
    this.row(`${" ".repeat(pad)}${value}`);
  }

  bottom(): void {
    this.rows.push(`└${"─".repeat(this.width - 2)}┘`);
  }

  toString(): string {
    return this.rows.join("\n");
  }
}

const RAIL_MARK: Record<LiveWorkNodeStatus, string> = {
  done: "█",
  active: "▐",
  blocked: "▚",
  pending: "░",
  unavailable: "░",
};

function renderRailBar(panel: Panel, pipeline: LiveWorkPipeline, style: TerminalStyle): void {
  const bar = pipeline.rail
    .map((stage) => paint(style, stage.status, RAIL_MARK[stage.status]))
    .join("");
  const done = pipeline.rail.filter((stage) => stage.status === "done").length;
  panel.field(
    "RAIL",
    `${bar}  ${style.bold(pipeline.completionLabel)}  ${style.grey(
      `${done}/${pipeline.rail.length}`,
    )}`,
  );
}

const NODE_LABEL_WIDTH = 7;

function renderNode(panel: Panel, node: LiveWorkNode, style: TerminalStyle): void {
  const glyph = paint(style, node.status, GLYPH[node.status]);
  const label = paint(style, node.status, padVisible(NODE_LABEL[node.key], NODE_LABEL_WIDTH));
  const room = panel.inner - 3 - NODE_LABEL_WIDTH - 1;
  panel.row(`${glyph}  ${label} ${style.dim(truncateVisible(node.detail, Math.max(0, room)))}`);
}

function renderPipelinePanel(
  pipeline: LiveWorkPipeline,
  style: TerminalStyle,
  width: number,
  now: Date,
): string {
  const panel = new Panel(style, width);
  panel.top("JARVIS · LIVE WORK");
  panel.row(style.grey(`updated ${isoMinute(pipeline.updatedAt)}Z`), style.grey(stamp(now)));
  panel.blank();
  panel.field("MISSION", style.bold(pipeline.objective ?? pipeline.subjectId));
  const subject =
    [pipeline.repository, pipeline.branch].filter(Boolean).join(" · ") || pipeline.subjectId;
  panel.field("SUBJECT", subject);
  const stateStyle = pipeline.missionInFlight ? style.violet : style.grey;
  panel.field("STATE", stateStyle(pipeline.completionLabel));
  panel.blank();

  renderRailBar(panel, pipeline, style);
  panel.blank();

  panel.rule("PIPELINE");
  for (const node of pipeline.nodes) renderNode(panel, node, style);

  panel.rule("BINDINGS");
  panel.row(
    style.grey(
      `v${pipeline.subjectVersion ?? "?"} · run ${pipeline.orchestrationRunId ?? "unbound"} · ` +
        `node ${pipeline.orchestrationNodeId ?? "unbound"} · fence ${pipeline.fencingToken ?? "?"}`,
    ),
  );
  const readiness = pipeline.omegaReadiness;
  panel.row(
    readiness.allowed
      ? style.green("ΩΣ readiness: READY — awaiting authoritative completion")
      : style.amber(`ΩΣ readiness: NOT READY (${readiness.failures.length})`),
  );
  if (!readiness.allowed) {
    for (const failure of readiness.failures.slice(0, 4)) {
      panel.row(style.grey(`  · ${failure}`));
    }
  }

  panel.rule("EVENTS");
  if (pipeline.events.length === 0) {
    panel.row(style.grey("No mission events recorded yet."));
  } else {
    for (const event of pipeline.events.slice(0, 6)) {
      panel.row(`${style.grey(`${isoMinute(event.at)}Z`)}  ${event.summary}`);
    }
  }

  panel.blank();
  panel.bottom();
  return panel.toString();
}

function renderMessagePanel(input: {
  style: TerminalStyle;
  width: number;
  now: Date;
  heading: string;
  headingStyle: (value: string) => string;
  lines: readonly string[];
}): string {
  const panel = new Panel(input.style, input.width);
  panel.top("JARVIS · LIVE WORK");
  panel.row("", input.style.grey(stamp(input.now)));
  panel.blank();
  panel.centered(input.headingStyle(input.style.bold(input.heading)));
  panel.blank();
  for (const line of input.lines) panel.centered(input.style.grey(line));
  panel.blank();
  panel.bottom();
  return panel.toString();
}

/** Renders one frame of the live-work monitor. Pure. */
export function renderLiveWorkTerminal(
  result: LiveWorkResult,
  options: LiveWorkTerminalOptions = {},
): string {
  const width = clampWidth(options.width);
  const style = createTerminalStyle(options.color ?? true);
  const now = options.now ?? new Date();

  if (result.status === "unavailable") {
    return renderMessagePanel({
      style,
      width,
      now,
      heading: "LIVE-WORK LINK UNAVAILABLE",
      headingStyle: style.red,
      lines: [result.reason],
    });
  }

  if (result.pipeline === null) {
    return renderMessagePanel({
      style,
      width,
      now,
      heading: "NO MISSION IN FLIGHT",
      headingStyle: style.green,
      lines: ["The development pipeline is clear.", "This panel wakes up when a mission starts."],
    });
  }

  return renderPipelinePanel(result.pipeline, style, width, now);
}
