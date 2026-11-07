import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { singleFlight } from "./hooks";
import { ACCENT_BADGE, ACCENT_TEXT, errorMessage, type SystemProcesses, type SystemStats } from "./model";

const STATS_POLL_MS = 2_000;
const PROCESSES_POLL_MS = 3_000;
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
  level: Level;
  gauges: Record<MetricKey, Gauge>;
  /** Mean swap in+out rate over the last ~10s, bytes/s. */
  swapRate: number;
  advice: { level: Level; text: string }[];
};

const LEVEL_RANK: Record<Level, number> = { ok: 0, warn: 1, critical: 2 };

const VERDICT: Record<Level, { label: string; badge: string; dot: string; text: string }> = {
  ok: { label: "Headroom", badge: ACCENT_BADGE.emerald, dot: "bg-emerald-500", text: ACCENT_TEXT.emerald },
  warn: { label: "Busy", badge: ACCENT_BADGE.amber, dot: "bg-amber-500", text: ACCENT_TEXT.amber },
  critical: { label: "Strained", badge: ACCENT_BADGE.rose, dot: "bg-rose-500", text: ACCENT_TEXT.rose },
};

/** Each metric's own hue: its glyph and chip, and its panel bar while it's fine. */
const HUE = {
  cpu: { text: "text-blue-500", bg: "bg-blue-500" },
  memory: { text: "text-red-500", bg: "bg-red-500" },
  disk: { text: "text-yellow-500", bg: "bg-yellow-500" },
  battery: { text: "text-green-500", bg: "bg-green-500" },
} satisfies Record<MetricKey, { text: string; bg: string }>;

/** Chip and panel bar colors once a metric nears running out, whatever its hue. */
const LEVEL_HUE = {
  warn: { text: "text-amber-500", bg: "bg-amber-500" },
  critical: { text: "text-rose-500", bg: "bg-rose-500" },
} satisfies Record<Exclude<Level, "ok">, { text: string; bg: string }>;

function tone(metric: MetricKey, level: Level) {
  return level === "ok" ? HUE[metric] : LEVEL_HUE[level];
}

// Solid glyphs (lucide has only outlines), drawn on a 20px grid and sized so each
// spans about the same height. They fill with `currentColor`, so a HUE text class tints them.
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

function worst(levels: Level[]): Level {
  return levels.reduce<Level>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "ok");
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
  const add = (level: Level, text: string) => advice.push({ level, text });
  if (memory.level === "critical") add("critical", "Memory is critically short. Stop a working thread or quit an app now; the machine is swapping hard.");
  if (cpu.level === "critical") add("critical", "CPU is maxed out. Working threads will crawl; lower the working limit or park some.");
  if (disk.level === "critical") add("critical", `Only ${formatBytes(free)} free on disk. Installs and builds will start failing; clear space now.`);
  if (battery.level === "critical") add("critical", `Battery at ${charge}%. Plug in now, or the machine and every thread with it will sleep.`);
  if (memory.level === "warn") add("warn", swapping ? `Memory is running short and the machine is swapping ${formatRate(swapRate)}. Don't start another thread yet.` : "Memory is getting short. Let working threads finish before starting new ones.");
  if (cpu.level === "warn") add("warn", "CPU is busy. Another thread will slow the ones already working.");
  if (disk.level === "warn") add("warn", `Disk is ${Math.round(disk.danger)}% full, ${formatBytes(free)} left. Clear caches and old worktrees before it runs out.`);
  if (battery.level === "warn") add("warn", `Battery at ${charge}%. Plug in before starting long runs.`);
  if (advice.length === 0) add("ok", "Nothing is close to running out. Fine to start more threads.");

  const gauges = { cpu, memory, disk, battery };
  return { level: worst(Object.values(gauges).map((entry) => entry.level)), gauges, swapRate, advice };
}

/** Polls `read` every `intervalMs` while `enabled` and the page is visible. */
function usePoll<T>(read: () => Promise<T>, intervalMs: number, enabled: boolean) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useMemo(
    () =>
      singleFlight(
        () =>
          Promise.race([
            read(),
            new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("The plugin server is not answering.")), READ_STALL_MS)),
          ]),
        (next: T) => {
          setValue(next);
          setError(null);
        },
        (cause) => setError(errorMessage(cause)),
      ),
    [read],
  );
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) refetch();
    };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refetch, intervalMs, enabled]);
  return { value, error };
}

function Bar({ segments, className = "" }: { segments: { value: number; className: string }[]; className?: string }) {
  return (
    <div className={`flex h-1.5 w-full overflow-hidden rounded-full bg-muted ${className}`}>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={`h-full transition-[width] duration-500 ease-out ${segment.className}`}
          style={{ width: `${Math.max(0, segment.value)}%` }}
        />
      ))}
    </div>
  );
}

/** Chip geometry, matching the hidden HTML copy that sizes it: 6px inset, 16px glyph, 4px gap, then the figure. */
const CHIP_HEIGHT = 24;
const CHIP_GLYPH = 16;
const CHIP_INSET = 6;
const CHIP_TEXT_X = CHIP_INSET + CHIP_GLYPH + 4;

/**
 * One gauge in the title-bar strip: a capsule in the metric's hue, half transparent, with its glyph and danger
 * percentage cut out of it so the title bar shows through. An invisible HTML copy of the glyph and figure sizes the
 * capsule; an SVG over it draws the fill through a mask that knocks the same glyph and figure out at the same
 * spots. The capsule turns amber, then rose, as the resource nears running out.
 */
function StripMetric({ danger, level, metric, charging, text }: {
  /** 0-100: the figure shown. */
  danger: number;
  level: Level;
  metric: MetricKey;
  /** Plugged-in battery: the glyph gets a bolt. */
  charging?: boolean;
  /** Shown in place of the percentage (plugged-in battery). */
  text?: string;
}) {
  const maskId = useId();
  const MetricGlyph = GLYPH[metric];
  const label = text ?? `${Math.round(danger)}%`;
  const figure = "text-[12px] font-bold tabular-nums";
  return (
    <span aria-hidden className="relative inline-flex h-6 shrink-0 items-center gap-1 pl-1.5 pr-2">
      <span className="invisible size-4" />
      <span className={`invisible leading-none ${figure}`}>{label}</span>
      <svg className={`absolute inset-0 size-full opacity-50 transition-[opacity,color] duration-300 group-hover:opacity-75 group-aria-expanded:opacity-75 ${tone(metric, level).text}`}>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          <MetricGlyph charging={charging} x={CHIP_INSET} y={(CHIP_HEIGHT - CHIP_GLYPH) / 2} size={CHIP_GLYPH} className="text-black" />
          <text x={CHIP_TEXT_X} y="50%" dominantBaseline="central" fill="black" className={figure}>
            {label}
          </text>
        </mask>
        <rect width="100%" height="100%" rx={CHIP_HEIGHT / 2} fill="currentColor" mask={`url(#${maskId})`} />
      </svg>
    </span>
  );
}

/**
 * Title-bar resource monitor for the bb server machine (where threads run, even when this page is open elsewhere):
 * a danger gauge each for CPU, memory pressure, disk and battery drain, where a high figure always means trouble.
 * Clicking opens a breakdown with advice and the heaviest processes.
 */
export function SystemMonitor({ maxPanelHeight }: { maxPanelHeight: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const readStats = useMemo(() => () => rpc.call("system_stats", null), [rpc]);
  const { value: stats, error } = usePoll(readStats, STATS_POLL_MS, true);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const assessment = useMemo(() => (stats ? assess(stats) : null), [stats]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const verdict = assessment ? VERDICT[assessment.level] : null;
  const summary = !stats || !assessment
    ? error ?? "Reading this machine's resources…"
    : `${stats.name}: ${verdict!.label}. ${assessment.advice[0]!.text}`;

  return (
    // Phones: `static`, so the panel spans the whole title bar like the search results.
    <div ref={rootRef} className="relative shrink-0 max-sm:static">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="group inline-flex h-8 cursor-pointer select-none items-center gap-1 rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-10"
      >
        <span className="sr-only">Machine resources. {summary}</span>
        {stats && assessment ? (
          <>
            <StripMetric metric="cpu" danger={assessment.gauges.cpu.danger} level={assessment.gauges.cpu.level} />
            <StripMetric metric="memory" danger={assessment.gauges.memory.danger} level={assessment.gauges.memory.level} />
            {stats.disk ? <StripMetric metric="disk" danger={assessment.gauges.disk.danger} level={assessment.gauges.disk.level} /> : null}
            {stats.battery ? (
              stats.battery.onBattery ? (
                <StripMetric metric="battery" danger={assessment.gauges.battery.danger} level={assessment.gauges.battery.level} />
              ) : (
                <StripMetric metric="battery" danger={0} level="ok" charging text="AC" />
              )
            ) : null}
          </>
        ) : (
          <span className="px-2.5 text-[11px] text-muted-foreground">{error ? "Resources unavailable" : "Reading…"}</span>
        )}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Machine resources"
          className="absolute right-0 top-full z-30 mt-1.5 flex w-[min(23rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] ring-1 ring-black/5 max-sm:inset-x-2 max-sm:w-auto"
          style={{ maxHeight: `${Math.max(maxPanelHeight, 160)}px` }}
        >
          {stats && assessment ? <SystemPanel stats={stats} assessment={assessment} error={error} /> : (
            <p className="px-3.5 py-3 text-[12px] text-muted-foreground">{error ?? "Reading this machine's resources…"}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Section({ label, metric, value, level, children }: { label: string; metric: MetricKey; value: ReactNode; level: Level; children: ReactNode }) {
  const MetricGlyph = GLYPH[metric];
  return (
    <section className="px-3.5 py-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          <MetricGlyph className={`size-3 ${HUE[metric].text}`} />
          {label}
          {level !== "ok" ? <span aria-hidden className={`size-1.5 rounded-full ${VERDICT[level].dot}`} /> : null}
        </h4>
        <span className={`text-[12.5px] font-semibold tabular-nums ${level === "ok" ? "text-foreground" : VERDICT[level].text}`}>{value}</span>
      </div>
      {children}
    </section>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground tabular-nums">{children}</p>;
}

const PRESSURE_LABEL = { normal: "Normal", warn: "Elevated", critical: "Critical" } as const;

function SystemPanel({ stats, assessment, error }: { stats: SystemStats; assessment: Assessment; error: string | null }) {
  const { cpu, memory, swap, disk, battery } = stats;
  const { gauges } = assessment;
  const verdict = VERDICT[assessment.level];
  const available = memory.availablePercent !== null ? (memory.availablePercent / 100) * memory.total : null;
  const breakdown = memory.app !== null && memory.wired !== null && memory.compressed !== null;

  return (
    <>
      <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-3.5 pb-2.5 pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-tight">{stats.name}</div>
          <div className="text-[10.5px] text-muted-foreground">
            {cpu.cores} cores · {formatBytes(memory.total, 0)} · up {formatDuration(stats.uptimeSec / 60)}
          </div>
        </div>
        <span className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide ${verdict.badge}`}>
          <span aria-hidden className={`size-1.5 rounded-full ${verdict.dot}`} />
          {verdict.label}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
        <ul className="space-y-1 border-b border-border/60 px-3.5 py-2.5">
          {assessment.advice.map((item) => (
            <li key={item.text} className="flex gap-2 text-[11.5px] leading-snug">
              <span aria-hidden className={`mt-[5px] size-1.5 shrink-0 rounded-full ${VERDICT[item.level].dot}`} />
              <span className={item.level === "ok" ? "text-muted-foreground" : "text-foreground"}>{item.text}</span>
            </li>
          ))}
          {error ? <li className="text-[11px] text-destructive">Last update failed: {error}</li> : null}
        </ul>

        <div className="divide-y divide-border/50">
          <Section label="CPU busy" metric="cpu" value={`${Math.round(gauges.cpu.danger)}%`} level={gauges.cpu.level}>
            <Bar segments={[{ value: gauges.cpu.danger, className: tone("cpu", gauges.cpu.level).bg }]} />
            <Detail>
              Average of all {cpu.cores} cores over the last 10 seconds.
              {cpu.groups.length ? <span className="block">{cpu.groups.map((group) => `${group.cores} ${group.name}`).join(" + ")}</span> : null}
            </Detail>
          </Section>

          <Section label="Memory pressure" metric="memory" value={`${Math.round(gauges.memory.danger)}%`} level={gauges.memory.level}>
            <Bar segments={[{ value: gauges.memory.danger, className: tone("memory", gauges.memory.level).bg }]} />
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

          {disk ? (
            <Section label="Disk full" metric="disk" value={`${Math.round(gauges.disk.danger)}%`} level={gauges.disk.level}>
              <Bar segments={[{ value: gauges.disk.danger, className: tone("disk", gauges.disk.level).bg }]} />
              <Detail>
                <span className="font-medium text-foreground/80">{formatBytes(disk.free)} free</span> of {formatBytes(disk.total, 0)} on the home volume
              </Detail>
            </Section>
          ) : null}

          {battery ? (
            <Section label={battery.onBattery ? "Battery drained" : "Battery"} metric="battery" value={battery.onBattery ? `${Math.round(gauges.battery.danger)}%` : "AC"} level={gauges.battery.level}>
              <Bar segments={[{ value: gauges.battery.danger, className: tone("battery", gauges.battery.level).bg }]} />
              <Detail>
                {battery.percent}% charge left · {battery.onBattery ? "on battery" : "plugged in"}, {battery.state}
                {battery.minutesLeft !== null ? ` · ${formatDuration(battery.minutesLeft)} ${battery.onBattery ? "left" : "to full"}` : null}
              </Detail>
            </Section>
          ) : null}

          <TopProcesses cores={cpu.cores} />
        </div>
      </div>

      <footer className="shrink-0 border-t border-border/60 px-3.5 py-2 text-[10.5px] leading-snug text-muted-foreground">
        Higher always means closer to running out. Measured on the machine running bb, every {Math.round(stats.intervalMs / 1000)}s, not on the device viewing this page.
      </footer>
    </>
  );
}

function TopProcesses({ cores }: { cores: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const read = useMemo(() => () => rpc.call("system_processes", null), [rpc]);
  const { value, error } = usePoll<SystemProcesses>(read, PROCESSES_POLL_MS, true);
  const [sort, setSort] = useState<"cpu" | "memory">("cpu");
  const rows = useMemo(
    () => (value?.groups ?? []).slice().sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu : b.memory - a.memory)).slice(0, PROCESS_ROWS),
    [value, sort],
  );
  const top = Math.max(1e-9, ...rows.map((row) => (sort === "cpu" ? row.cpu : row.memory)));
  const problem = error ?? value?.error ?? null;

  return (
    <section className="px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Heaviest apps</h4>
        <div role="radiogroup" aria-label="Sort by" className="inline-flex rounded-md bg-muted p-0.5 text-[10px] font-semibold">
          {(["cpu", "memory"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={sort === key}
              onClick={() => setSort(key)}
              className={`cursor-pointer rounded px-1.5 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:px-2.5 pointer-coarse:py-1.5 ${sort === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {key === "cpu" ? "CPU" : "Memory"}
            </button>
          ))}
        </div>
      </div>
      {rows.length > 0 ? (
        <ul className="space-y-1">
          {rows.map((row) => {
            const metric = sort === "cpu" ? row.cpu : row.memory;
            return (
              <li key={row.name} className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.75rem] items-center gap-2 text-[11.5px]">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-medium" title={row.name}>{row.name}</span>
                  {row.count > 1 ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">×{row.count}</span> : null}
                </span>
                <Bar segments={[{ value: (metric / top) * 100, className: sort === "cpu" ? "bg-blue-500/70" : "bg-red-500/70" }]} className="h-1" />
                <span className="text-right tabular-nums text-muted-foreground">
                  {sort === "cpu" ? `${(row.cpu / 100).toFixed(row.cpu >= 1000 ? 0 : 1)} core${row.cpu === 100 ? "" : "s"}` : formatBytes(row.memory)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">{problem ?? "Reading processes…"}</p>
      )}
      <Detail>
        {sort === "cpu"
          ? `Grouped by app; 1 core = one of ${cores} fully busy, averaged over the last minute.`
          : "Grouped by app; resident memory, so compressed and swapped pages aren't counted."}
      </Detail>
    </section>
  );
}
