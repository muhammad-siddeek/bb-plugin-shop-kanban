import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { usePoll } from "./hooks";
import { ACCENT_TEXT, type AiUsage, type SystemProcesses, type SystemStats } from "./model";
import { TYPE } from "./primitives";

const STATS_POLL_MS = 2_000;
const PROCESSES_POLL_MS = 3_000;
/** The server caches the proxy's figure for a minute; polling faster would only reread its cache. */
const AI_USAGE_POLL_MS = 60_000;
/** Shopify AI spend today (USD) at which the chip turns amber. */
const AI_SPEND_WARN_USD = 450;
const READ_STALL_MS = 15_000;
/** Usage levels judge the mean of this many recent samples (10s), so one spike doesn't flash the monitor. */
const SMOOTH_SAMPLES = 5;
const PROCESS_ROWS = 6;

const GB = 2 ** 30;
const MB = 2 ** 20;

// Every gauge reads as danger: 0 is safe, 100 is out of the resource. `levels` below are where each turns amber
// (warn) and red (critical).
// CPU: share of all cores busy, averaged over ~10s.
// Memory: 100 - what macOS counts as available to apps. "Used" is useless on macOS (it caches into everything);
//   the kernel's pressure level and sustained swapping lift it into the warn and critical range.
// Disk: share of the home volume used; also warns on little absolute space, which is what stops builds and installs.
// Battery: share drained while unplugged; plugged in there is nothing to run out of.
const LEVELS = {
  cpu: { warn: 80, critical: 95 },
  memory: { warn: 80, critical: 90 },
  disk: { warn: 90, critical: 96 },
  battery: { warn: 80, critical: 90 },
} satisfies Record<MetricKey, { warn: number; critical: number }>;
const SWAP_RATE_WARN = 10 * MB;
const DISK_FREE_WARN = 25 * GB;
const DISK_FREE_CRITICAL = 10 * GB;

type Level = "ok" | "warn" | "critical";
type MetricKey = "cpu" | "memory" | "disk" | "battery";
type Gauge = { danger: number; level: Level };
type Assessment = {
  gauges: Record<MetricKey, Gauge>;
  /** Mean swap in+out rate over the last ~10s, bytes/s. */
  swapRate: number;
  advice: { level: Level; text: string; metric: MetricKey | null }[];
};

/** Which chip's popover is open: one resource at a time. */
type PanelKey = MetricKey | "ai";

const VERDICT: Record<Level, { dot: string; text: string }> = {
  ok: { dot: "bg-emerald-500", text: ACCENT_TEXT.emerald },
  warn: { dot: "bg-amber-500", text: ACCENT_TEXT.amber },
  critical: { dot: "bg-rose-500", text: ACCENT_TEXT.rose },
};

/** Chip and bar colors: neutral while fine, so the strip only draws the eye when a metric nears running out. */
const TONE: Record<Level, { text: string; bg: string }> = {
  ok: { text: "text-muted-foreground", bg: "bg-muted-foreground/60" },
  warn: { text: "text-amber-500", bg: "bg-amber-500" },
  critical: { text: "text-rose-500", bg: "bg-rose-500" },
};

// Solid glyphs (lucide has only outlines), drawn on a 20px grid and sized so each
// spans about the same height. They fill with `currentColor`, so a text color class tints them.
/** `x`, `y` and `size` place a glyph nested in another SVG (the chip's cut-out mask). */
type GlyphProps = { className?: string; x?: number; y?: number; size?: number };

function Glyph({ className, x, y, size, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" x={x} y={y} width={size} height={size} className={className} aria-hidden>
      {children}
    </svg>
  );
}

/** A chip with a hollow core and three pins a side. */
function CpuGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path fillRule="evenodd" d="M6 4h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2.5 4a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3Z" />
      {[5, 9, 13].map((at) => (
        <g key={at}>
          <rect x={at} y="1" width="2" height="3.5" rx=".5" />
          <rect x={at} y="15.5" width="2" height="3.5" rx=".5" />
          <rect x="1" y={at} width="3.5" height="2" rx=".5" />
          <rect x="15.5" y={at} width="3.5" height="2" rx=".5" />
        </g>
      ))}
    </Glyph>
  );
}

/** A memory stick: board with three chip cut-outs over a notched row of contacts. */
function MemoryGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path fillRule="evenodd" d="M2.5 3h15A1.5 1.5 0 0 1 19 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 1 12.5v-8A1.5 1.5 0 0 1 2.5 3ZM3 6v5h4V6H3Zm5 0v5h4V6H8Zm5 0v5h4V6h-4Z" />
      {[2, 4, 6, 13, 15, 17].map((at) => (
        <rect key={at} x={at} y="15" width="1" height="2.5" rx=".4" />
      ))}
    </Glyph>
  );
}

/** A hard drive: slanted top over a box with a slot and an activity light. */
function DiskGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M5.9 2.5h8.2a1.5 1.5 0 0 1 1.35.85L18.5 9.5h-17l3.05-6.15a1.5 1.5 0 0 1 1.35-.85Z" />
      <path fillRule="evenodd" d="M3.5 10.5h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Zm1.25 2.75a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5ZM14.75 12.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" />
    </Glyph>
  );
}

/** A full battery; `charging` cuts a bolt through it. */
function BatteryGlyph({ charging = false, ...props }: GlyphProps & { charging?: boolean }) {
  return (
    <Glyph {...props}>
      <path
        fillRule="evenodd"
        d={`M3.5 4h11A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 1 13.5v-7A2.5 2.5 0 0 1 3.5 4Z${charging ? "M10 5.75 5.5 10.75h3l-1 3.5 4.5-5h-3l1-3.5Z" : ""}`}
      />
      <rect x="18" y="7.5" width="1.5" height="5" rx=".75" />
    </Glyph>
  );
}

/** A four-point sparkle with a small companion: AI spend. */
function SparkleGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M8.5 2c.3 0 .55.2.62.49l.7 2.8a3.5 3.5 0 0 0 2.54 2.54l2.8.7a.64.64 0 0 1 0 1.24l-2.8.7a3.5 3.5 0 0 0-2.54 2.54l-.7 2.8a.64.64 0 0 1-1.24 0l-.7-2.8a3.5 3.5 0 0 0-2.54-2.54l-2.8-.7a.64.64 0 0 1 0-1.24l2.8-.7a3.5 3.5 0 0 0 2.54-2.54l.7-2.8A.64.64 0 0 1 8.5 2Z" />
      <path d="M15.5 12.5c.18 0 .33.12.38.29l.32 1.2a1.5 1.5 0 0 0 1.06 1.06l1.2.32a.39.39 0 0 1 0 .76l-1.2.32a1.5 1.5 0 0 0-1.06 1.06l-.32 1.2a.39.39 0 0 1-.76 0l-.32-1.2a1.5 1.5 0 0 0-1.06-1.06l-1.2-.32a.39.39 0 0 1 0-.76l1.2-.32a1.5 1.5 0 0 0 1.06-1.06l.32-1.2a.39.39 0 0 1 .38-.29Z" />
    </Glyph>
  );
}

function aiLevel(usage: AiUsage | null): Level {
  return usage?.todayCost != null && usage.todayCost >= AI_SPEND_WARN_USD ? "warn" : "ok";
}

function formatUsd(value: number, cents = true): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
}

function formatTokens(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(count >= 1e10 ? 0 : 1)}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}K`;
  return String(count);
}

const GLYPH: Record<MetricKey, (props: GlyphProps & { charging?: boolean }) => ReactNode> = {
  cpu: CpuGlyph,
  memory: MemoryGlyph,
  disk: DiskGlyph,
  battery: BatteryGlyph,
};

function mean(values: number[]): number {
  const recent = values.slice(-SMOOTH_SAMPLES);
  return recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
}


function formatBytes(bytes: number, digits = 1): string {
  if (bytes >= 1000 * GB) return `${(bytes / (1024 * GB)).toFixed(digits)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : digits)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 0.1 * MB) return "0 MB/s";
  return `${(bytesPerSec / MB).toFixed(bytesPerSec >= 10 * MB ? 0 : 1)} MB/s`;
}

function formatDuration(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = Math.floor(totalMinutes % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0;
}

function levelOf(metric: MetricKey, danger: number): Level {
  const { warn, critical } = LEVELS[metric];
  return danger >= critical ? "critical" : danger >= warn ? "warn" : "ok";
}

/** A gauge whose level can be raised by signals the percentage alone doesn't carry; the figure rises with it. */
function gauge(metric: MetricKey, danger: number, minimum: Level = "ok"): Gauge {
  const { warn, critical } = LEVELS[metric];
  const floor = minimum === "critical" ? critical : minimum === "warn" ? warn : 0;
  const shown = Math.min(100, Math.max(0, danger, floor));
  return { danger: shown, level: levelOf(metric, shown) };
}

function assess(stats: SystemStats): Assessment {
  const cpuNow = mean(stats.history.cpu);
  const cpu = gauge("cpu", cpuNow);

  const { pressure, availablePercent, used, total } = stats.memory;
  const swapRate = mean(stats.history.swapRate);
  const swapping = stats.swap !== null && swapRate >= SWAP_RATE_WARN;
  const memoryBase = availablePercent !== null ? 100 - availablePercent : percent(used, total);
  const memory = gauge("memory", memoryBase, pressure === "critical" ? "critical" : pressure === "warn" || swapping ? "warn" : "ok");

  const usedShare = stats.disk ? percent(stats.disk.total - stats.disk.free, stats.disk.total) : 0;
  const free = stats.disk?.free ?? Infinity;
  const disk = gauge("disk", usedShare, free < DISK_FREE_CRITICAL ? "critical" : free < DISK_FREE_WARN ? "warn" : "ok");

  // Plugged in (or no battery): nothing to drain.
  const charge = stats.battery?.percent ?? 100;
  const battery = gauge("battery", stats.battery?.onBattery ? 100 - charge : 0);

  const advice: Assessment["advice"] = [];
  const add = (level: Level, text: string, metric: MetricKey | null) => advice.push({ level, text, metric });
  if (memory.level === "critical") add("critical", "Memory is critically short. Stop a working thread or quit an app now; the machine is swapping hard.", "memory");
  if (cpu.level === "critical") add("critical", "CPU is maxed out. Working threads will crawl; lower the working limit or park some.", "cpu");
  if (disk.level === "critical") add("critical", `Only ${formatBytes(free)} free on disk. Installs and builds will start failing; clear space now.`, "disk");
  if (battery.level === "critical") add("critical", `Battery at ${charge}%. Plug in now, or the machine and every thread with it will sleep.`, "battery");
  if (memory.level === "warn") add("warn", swapping ? `Memory is running short and the machine is swapping ${formatRate(swapRate)}. Don't start another thread yet.` : "Memory is getting short. Let working threads finish before starting new ones.", "memory");
  if (cpu.level === "warn") add("warn", "CPU is busy. Another thread will slow the ones already working.", "cpu");
  if (disk.level === "warn") add("warn", `Disk is ${Math.round(disk.danger)}% full, ${formatBytes(free)} left. Clear caches and old worktrees before it runs out.`, "disk");
  if (battery.level === "warn") add("warn", `Battery at ${charge}%. Plug in before starting long runs.`, "battery");
  if (advice.length === 0) add("ok", "Nothing is close to running out. Fine to start more threads.", null);

  return { gauges: { cpu, memory, disk, battery }, swapRate, advice };
}

/** The monitor's reads fail sooner than the board's: a stale gauge misleads. */
function useMonitorPoll<T>(read: () => Promise<T>, intervalMs: number) {
  return usePoll(read, intervalMs, READ_STALL_MS, "The plugin server is not answering.");
}

/** A bar filled `value` percent. */
function Bar({ value, tint, className = "" }: { value: number; tint: string; className?: string }) {
  return (
    <div className={`flex h-1.5 w-full overflow-hidden rounded-full bg-muted ${className}`}>
      <span className={`h-full transition-[width] duration-500 ease-out ${tint}`} style={{ width: `${Math.max(0, value)}%` }} />
    </div>
  );
}

/** One chip's content in the title-bar strip: glyph and figure, tinted amber or rose as its resource nears running out. */
function StripChip({ glyph, label, level, dim = false }: { glyph: ReactNode; label: string; level: Level; dim?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 ${TYPE.meta} font-medium leading-none tabular-nums transition-colors duration-300 ${
        level === "ok"
          ? "text-muted-foreground group-hover:text-foreground group-aria-expanded:text-foreground"
          : `${TONE[level].text} ${level === "critical" ? "bg-rose-500/15" : "bg-amber-500/15"}`
      } ${dim ? "opacity-60" : ""}`}
    >
      {glyph}
      {label}
    </span>
  );
}

/** Hover this long before a chip's popover opens, so sweeping across the title bar doesn't flash them. */
const HOVER_OPEN_MS = 250;
/** Grace period for moving the pointer from a chip into its popover. */
const HOVER_CLOSE_MS = 200;

const PANEL_LABEL: Record<PanelKey, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
  battery: "Battery",
  ai: "Shopify AI spend",
};

/**
 * Title-bar resource monitor for the bb server machine (where threads run, even when this page is open elsewhere):
 * a borderless danger chip each for CPU, memory pressure, disk and battery drain (a high figure always means
 * trouble), plus today's AI spend. Hovering or clicking a chip opens a popover about that resource alone; a click
 * pins it open until clicking again, outside, or Escape.
 */
export function SystemMonitor({ maxPanelHeight }: { maxPanelHeight: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const readStats = useMemo(() => () => rpc.call("system_stats", null), [rpc]);
  const { value: stats, error } = useMonitorPoll(readStats, STATS_POLL_MS);
  const [open, setOpen] = useState<PanelKey | null>(null);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const panelId = useId();
  const assessment = useMemo(() => (stats ? assess(stats) : null), [stats]);
  const readAiUsage = useMemo(() => () => rpc.call("ai_usage", null), [rpc]);
  const { value: aiUsage } = useMonitorPoll<AiUsage>(readAiUsage, AI_USAGE_POLL_MS);

  const close = () => {
    window.clearTimeout(hoverTimer.current);
    setOpen(null);
    setPinned(false);
  };

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const hoverChip = (key: PanelKey) => (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse" || pinned) return;
    window.clearTimeout(hoverTimer.current);
    // Already showing one: switch at once, like a menu bar.
    if (open) setOpen(key);
    else hoverTimer.current = window.setTimeout(() => setOpen(key), HOVER_OPEN_MS);
  };
  const leaveRoot = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse" || pinned) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setOpen(null), HOVER_CLOSE_MS);
  };
  const enterRoot = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse" || pinned || !open) return;
    window.clearTimeout(hoverTimer.current);
  };
  const clickChip = (key: PanelKey) => () => {
    window.clearTimeout(hoverTimer.current);
    if (open === key && pinned) close();
    else {
      setOpen(key);
      setPinned(true);
    }
  };

  const chip = (key: PanelKey, content: ReactNode, summary: string) => (
    <button
      key={key}
      type="button"
      aria-expanded={open === key}
      aria-controls={open === key ? panelId : undefined}
      onPointerEnter={hoverChip(key)}
      onClick={clickChip(key)}
      className="group inline-flex h-7 cursor-pointer select-none items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-9"
    >
      <span className="sr-only">{summary}</span>
      {content}
    </button>
  );

  const pct = (value: number) => `${Math.round(value)}%`;
  const gauges = assessment?.gauges;
  const gaugeChip = (metric: MetricKey, { danger, level }: Gauge, summary: string) => {
    const MetricGlyph = GLYPH[metric];
    return chip(metric, <StripChip glyph={<MetricGlyph className="size-3 shrink-0" />} label={pct(danger)} level={level} />, summary);
  };

  return (
    // Phones: `static`, so the panel spans the whole title bar like the search results.
    <div ref={rootRef} onPointerLeave={leaveRoot} onPointerEnter={enterRoot} className="relative flex shrink-0 items-center max-sm:static">
      {stats && gauges ? (
        <>
          {gaugeChip("cpu", gauges.cpu, `CPU ${pct(gauges.cpu.danger)} busy`)}
          {gaugeChip("memory", gauges.memory, `Memory pressure ${pct(gauges.memory.danger)}`)}
          {stats.disk ? gaugeChip("disk", gauges.disk, `Disk ${pct(gauges.disk.danger)} full`) : null}
          {stats.battery?.onBattery ? gaugeChip("battery", gauges.battery, `Battery ${pct(gauges.battery.danger)} drained`) : null}
          {stats.battery && !stats.battery.onBattery
            ? chip("battery", <StripChip glyph={<BatteryGlyph charging className="size-3 shrink-0" />} label="AC" level="ok" />, "Battery plugged in")
            : null}
        </>
      ) : (
        <span className={`px-1 ${TYPE.meta} text-muted-foreground`}>{error ? "Resources unavailable" : "Reading…"}</span>
      )}
      {/* Today's Shopify AI spend: neutral below AI_SPEND_WARN_USD, amber from it. */}
      {aiUsage?.todayCost != null
        ? chip(
            "ai",
            <StripChip glyph={<SparkleGlyph className="size-3 shrink-0" />} label={formatUsd(aiUsage.todayCost, false)} level={aiLevel(aiUsage)} dim={Boolean(aiUsage.error)} />,
            `Shopify AI spend today ${formatUsd(aiUsage.todayCost)}`,
          )
        : null}

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={PANEL_LABEL[open]}
          className="absolute right-0 top-full z-30 mt-1 flex w-[min(19rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] ring-1 ring-black/5 max-sm:inset-x-2 max-sm:w-auto"
          style={{ maxHeight: `${Math.max(maxPanelHeight, 160)}px` }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            {open === "ai" ? (
              aiUsage ? <AiUsageSection usage={aiUsage} /> : null
            ) : stats && assessment ? (
              <MetricPanel metric={open} stats={stats} assessment={assessment} error={error} />
            ) : (
              <p className={`px-3.5 py-3 ${TYPE.body} text-muted-foreground`}>{error ?? "Reading this machine's resources…"}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A popover's resource: its glyph, name and figure, and a bar `bar` percent full when it has one. */
function Section({ label, glyph: SectionGlyph, value, level, bar, children }: {
  label: string;
  glyph: (props: GlyphProps) => ReactNode;
  value: ReactNode;
  level: Level;
  bar: number | null;
  children: ReactNode;
}) {
  return (
    <section className="px-3.5 py-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className={`flex items-center gap-1.5 ${TYPE.label} text-muted-foreground`}>
          <SectionGlyph className="size-3 text-muted-foreground" />
          {label}
          {level !== "ok" ? <span aria-hidden className={`size-1.5 rounded-full ${VERDICT[level].dot}`} /> : null}
        </h4>
        <span className={`${TYPE.title} font-semibold tabular-nums ${level === "ok" ? "text-foreground" : VERDICT[level].text}`}>{value}</span>
      </div>
      {bar !== null ? <Bar value={bar} tint={TONE[level].bg} /> : null}
      {children}
    </section>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return <p className={`mt-1.5 ${TYPE.meta} leading-snug text-muted-foreground tabular-nums`}>{children}</p>;
}

const PRESSURE_LABEL = { normal: "Normal", warn: "Elevated", critical: "Critical" } as const;

/** One resource's popover: its gauge, details, any advice about it, and for CPU and memory the heaviest apps. */
function MetricPanel({ metric, stats, assessment, error }: { metric: MetricKey; stats: SystemStats; assessment: Assessment; error: string | null }) {
  const { cpu, memory, swap, disk, battery } = stats;
  const { gauges } = assessment;
  const available = memory.availablePercent !== null ? (memory.availablePercent / 100) * memory.total : null;
  const breakdown = memory.app !== null && memory.wired !== null && memory.compressed !== null;
  const advice = assessment.advice.filter((item) => item.metric === metric);

  return (
    <>
      {metric === "cpu" ? (
        <Section label="CPU busy" glyph={CpuGlyph} value={`${Math.round(gauges.cpu.danger)}%`} level={gauges.cpu.level} bar={gauges.cpu.danger}>
          <Detail>
            Average of all {cpu.cores} cores over the last 10 seconds.
            {cpu.groups.length ? <span className="block">{cpu.groups.map((group) => `${group.cores} ${group.name}`).join(" + ")}</span> : null}
            <span className="block text-muted-foreground/70">{stats.name} · up {formatDuration(stats.uptimeSec / 60)}</span>
          </Detail>
        </Section>
      ) : null}

      {metric === "memory" ? (
        <Section label="Memory pressure" glyph={MemoryGlyph} value={`${Math.round(gauges.memory.danger)}%`} level={gauges.memory.level} bar={gauges.memory.danger}>
          <Detail>
            {available !== null ? <span className="block">{formatBytes(available)} of {formatBytes(memory.total, 0)} still available to apps</span> : null}
            {memory.pressure ? (
              <span className="block">
                macOS pressure{" "}
                <span className={`font-medium ${gauges.memory.level === "ok" ? "text-foreground/80" : VERDICT[gauges.memory.level].text}`}>{PRESSURE_LABEL[memory.pressure]}</span>
              </span>
            ) : null}
            {swap ? (
              <span className="block">
                {swap.inPerSec === null || swap.outPerSec === null
                  ? "Measuring swap activity…"
                  : assessment.swapRate < 0.1 * MB
                    ? "Not swapping"
                    : `Swapping ${formatRate(assessment.swapRate)}`}
                <span className="text-muted-foreground/70"> · {formatBytes(swap.used)} sitting in swap</span>
              </span>
            ) : null}
            {breakdown ? (
              <span className="block text-muted-foreground/70">
                Apps {formatBytes(memory.app!)} · Wired {formatBytes(memory.wired!)} · Compressed {formatBytes(memory.compressed!)}
              </span>
            ) : null}
          </Detail>
        </Section>
      ) : null}

      {metric === "disk" && disk ? (
        <Section label="Disk full" glyph={DiskGlyph} value={`${Math.round(gauges.disk.danger)}%`} level={gauges.disk.level} bar={gauges.disk.danger}>
          <Detail>
            <span className="font-medium text-foreground/80">{formatBytes(disk.free)} free</span> of {formatBytes(disk.total, 0)} on the home volume
          </Detail>
        </Section>
      ) : null}

      {metric === "battery" && battery ? (
        <Section
          label={battery.onBattery ? "Battery drained" : "Battery"}
          glyph={BatteryGlyph}
          value={battery.onBattery ? `${Math.round(gauges.battery.danger)}%` : "AC"}
          level={gauges.battery.level}
          bar={gauges.battery.danger}
        >
          <Detail>
            {battery.percent}% charge left · {battery.onBattery ? "on battery" : "plugged in"}, {battery.state}
            {battery.minutesLeft !== null ? ` · ${formatDuration(battery.minutesLeft)} ${battery.onBattery ? "left" : "to full"}` : null}
          </Detail>
        </Section>
      ) : null}

      {advice.length > 0 || error ? (
        <ul className="space-y-1 px-3.5 pb-2.5">
          {advice.map((item) => (
            <li key={item.text} className={`flex gap-2 ${TYPE.meta} leading-snug`}>
              <span aria-hidden className={`mt-[5px] size-1.5 shrink-0 rounded-full ${VERDICT[item.level].dot}`} />
              <span className="text-foreground">{item.text}</span>
            </li>
          ))}
          {error ? <li className={`${TYPE.meta} text-destructive`}>Last update failed: {error}</li> : null}
        </ul>
      ) : null}

      {metric === "cpu" || metric === "memory" ? (
        <div className="border-t border-border/50">
          <TopProcesses cores={cpu.cores} sort={metric} />
        </div>
      ) : null}
    </>
  );
}

function AiUsageSection({ usage }: { usage: AiUsage }) {
  const level = aiLevel(usage);
  const tokens = usage.todayTokens;
  return (
    <Section
      label="Shopify AI today"
      glyph={SparkleGlyph}
      value={usage.todayCost !== null ? formatUsd(usage.todayCost) : "—"}
      level={level}
      bar={usage.todayCost !== null ? percent(usage.todayCost, AI_SPEND_WARN_USD) : null}
    >
      {usage.topModels.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {usage.topModels.map((model) => (
            <li key={model.name} className={`grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem] items-center gap-2 ${TYPE.meta}`}>
              <span className="truncate" title={model.name}>{model.name}</span>
              <span className="text-right tabular-nums text-muted-foreground">{formatTokens(model.tokens)}</span>
              <span className="text-right tabular-nums">{formatUsd(model.cost)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Detail>
        {level !== "ok" ? <span className={`block font-medium ${VERDICT.warn.text}`}>Past the {formatUsd(AI_SPEND_WARN_USD, false)} daily mark.</span> : null}
        {tokens ? (
          <span className="block">
            {formatTokens(tokens.input)} input ({formatTokens(tokens.cachedInput)} cached) · {formatTokens(tokens.output)} output tokens
          </span>
        ) : null}
        {usage.hourCost !== null && usage.sevenDaysCost !== null ? (
          <span className="block text-muted-foreground/70">
            {formatUsd(usage.hourCost)} this hour · {formatUsd(usage.sevenDaysCost)} over 7 days · {usage.timezone}
          </span>
        ) : null}
        {usage.pricingStale ? <span className="block">The proxy has no pricing loaded; costs read $0.</span> : null}
        {usage.error ? <span className="block text-destructive">Last update failed: {usage.error}</span> : null}
        <span className="block text-muted-foreground/70">All your Shopify AI proxy use, not just bb threads. Amber from {formatUsd(AI_SPEND_WARN_USD, false)}.</span>
      </Detail>
    </Section>
  );
}

function TopProcesses({ cores, sort }: { cores: number; sort: "cpu" | "memory" }) {
  const rpc = useRpc<typeof rpcContract>();
  const read = useMemo(() => () => rpc.call("system_processes", null), [rpc]);
  const { value, error } = useMonitorPoll<SystemProcesses>(read, PROCESSES_POLL_MS);
  const rows = useMemo(
    () => (value?.groups ?? []).slice().sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu : b.memory - a.memory)).slice(0, PROCESS_ROWS),
    [value, sort],
  );
  const top = Math.max(1e-9, ...rows.map((row) => (sort === "cpu" ? row.cpu : row.memory)));
  const problem = error ?? value?.error ?? null;

  return (
    <section className="px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className={`${TYPE.label} text-muted-foreground`}>Heaviest apps</h4>
      </div>
      {rows.length > 0 ? (
        <ul className="space-y-1">
          {rows.map((row) => {
            const metric = sort === "cpu" ? row.cpu : row.memory;
            return (
              <li key={row.name} className={`grid grid-cols-[minmax(0,1fr)_4.5rem_3.75rem] items-center gap-2 ${TYPE.meta}`}>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-medium" title={row.name}>{row.name}</span>
                  {row.count > 1 ? <span className={`shrink-0 ${TYPE.meta} tabular-nums text-muted-foreground`}>×{row.count}</span> : null}
                </span>
                <Bar value={(metric / top) * 100} tint={sort === "cpu" ? "bg-blue-500/70" : "bg-red-500/70"} className="h-1" />
                <span className="text-right tabular-nums text-muted-foreground">
                  {sort === "cpu" ? `${(row.cpu / 100).toFixed(row.cpu >= 1000 ? 0 : 1)} core${row.cpu === 100 ? "" : "s"}` : formatBytes(row.memory)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={`${TYPE.meta} text-muted-foreground`}>{problem ?? "Reading processes…"}</p>
      )}
      <Detail>
        {sort === "cpu"
          ? `Grouped by app; 1 core = one of ${cores} fully busy, averaged over the last minute.`
          : "Grouped by app; resident memory, so compressed and swapped pages aren't counted."}
      </Detail>
    </section>
  );
}
