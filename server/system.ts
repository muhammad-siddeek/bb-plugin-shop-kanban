// Resource monitor for the bb server machine: the computer bb runs on, which the plugin server shares, so it reads
// the same numbers whether the board is open on that machine or in a browser elsewhere.

import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { cpus, homedir, hostname, loadavg, platform, totalmem, freemem, uptime } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SystemProcesses, SystemStats } from "./schema";

const SAMPLE_MS = 2_000;
/** Samples kept for the sparklines: two minutes. */
const HISTORY_MAX = 60;
/** The sampler stops this long after the last read, so a closed board costs nothing. */
const IDLE_STOP_MS = 30_000;
/** The first read waits this long between two CPU readings to have a usage figure at all. */
const FIRST_SAMPLE_GAP_MS = 400;
const BATTERY_EVERY_MS = 30_000;
const PROCESSES_CACHE_MS = 2_500;
const PROCESS_GROUPS_MAX = 40;
const COMMAND_TIMEOUT_MS = 3_000;

const PRESSURE_LEVELS: Record<string, SystemStats["memory"]["pressure"]> = { "1": "normal", "2": "warn", "4": "critical" };

type CpuTimes = { idle: number; total: number };
type Memory = SystemStats["memory"];
type Swap = { total: number; used: number; pagesIn: number | null; pagesOut: number | null; pageSize: number } | null;

/** stdout of a short system command; empty when it fails or is missing. Never rejects. */
function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4_000_000, encoding: "utf8" }, (_error, stdout) =>
        // sysctl prints the keys it knows even when it exits non-zero over one it doesn't.
        resolve(typeof stdout === "string" ? stdout : ""),
      );
    } catch {
      resolve("");
    }
  });
}

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function cpuPercent(previous: CpuTimes, next: CpuTimes): number {
  const total = next.total - previous.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (1 - (next.idle - previous.idle) / total) * 100));
}

/** `key: value` lines (sysctl, vm_stat, /proc/meminfo) as a map; values keep their text. */
function keyValues(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) map.set(line.slice(0, at).trim().replace(/^"|"$/g, ""), line.slice(at + 1).trim());
  }
  return map;
}

function int(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** sysctl's `12288.00M` style sizes, in bytes. */
function sysctlSize(text: string | undefined): number | null {
  const match = text?.match(/([\d.]+)\s*([KMGT])?/i);
  if (!match) return null;
  const scale = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 }[(match[2] ?? "").toUpperCase()] ?? 1;
  return Number(match[1]) * scale;
}

async function macMemory(): Promise<{ memory: Memory; swap: Swap }> {
  const [vmStat, sysctl] = await Promise.all([
    output("vm_stat", []),
    output("sysctl", ["kern.memorystatus_vm_pressure_level", "kern.memorystatus_level", "vm.swapusage"]),
  ]);
  const vm = keyValues(vmStat);
  const ctl = keyValues(sysctl);
  const pageSize = int(vmStat.match(/page size of (\d+) bytes/)?.[1]) ?? 16_384;
  const pages = (key: string) => {
    const value = int(vm.get(key));
    return value === null ? null : value * pageSize;
  };
  const total = totalmem();
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable") ?? 0;
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const fileBacked = pages("File-backed pages");
  const app = anonymous === null ? null : Math.max(0, anonymous - purgeable);
  // Activity Monitor's Memory Used. Without vm_stat, fall back to Node's figure (free pages only on macOS: too high).
  const used = app !== null && wired !== null && compressed !== null ? app + wired + compressed : total - freemem();
  const level = int(ctl.get("kern.memorystatus_level"));
  const swapText = ctl.get("vm.swapusage");
  const swapTotal = sysctlSize(swapText?.match(/total\s*=\s*(\S+)/)?.[1]);
  const swapUsed = sysctlSize(swapText?.match(/used\s*=\s*(\S+)/)?.[1]);
  return {
    memory: {
      total,
      used: Math.min(total, used),
      app,
      wired,
      compressed,
      cached: fileBacked === null ? null : fileBacked + purgeable,
      pressure: PRESSURE_LEVELS[ctl.get("kern.memorystatus_vm_pressure_level") ?? ""] ?? null,
      availablePercent: level !== null && level >= 0 && level <= 100 ? level : null,
    },
    swap:
      swapTotal !== null && swapUsed !== null
        ? { total: swapTotal, used: swapUsed, pagesIn: int(vm.get("Swapins")), pagesOut: int(vm.get("Swapouts")), pageSize }
        : null,
  };
}

async function linuxMemory(): Promise<{ memory: Memory; swap: Swap }> {
  const [meminfo, vmstat] = await Promise.all([
    readFile("/proc/meminfo", "utf8").catch(() => ""),
    readFile("/proc/vmstat", "utf8").catch(() => ""),
  ]);
  const info = keyValues(meminfo);
  const kb = (key: string) => {
    const value = int(info.get(key));
    return value === null ? null : value * 1024;
  };
  const total = kb("MemTotal") ?? totalmem();
  const available = kb("MemAvailable") ?? freemem();
  const counters = new Map(vmstat.split("\n").map((line) => line.split(" ") as [string, string]));
  const swapTotal = kb("SwapTotal");
  const swapFree = kb("SwapFree");
  const cached = (kb("Cached") ?? 0) + (kb("Buffers") ?? 0);
  return {
    memory: {
      total,
      used: Math.max(0, total - available),
      app: null,
      wired: null,
      compressed: null,
      cached: cached || null,
      pressure: null,
      availablePercent: total > 0 ? (available / total) * 100 : null,
    },
    swap:
      swapTotal !== null && swapFree !== null && swapTotal > 0
        ? { total: swapTotal, used: swapTotal - swapFree, pagesIn: int(counters.get("pswpin")), pagesOut: int(counters.get("pswpout")), pageSize: 4096 }
        : null,
  };
}

function genericMemory(): { memory: Memory; swap: Swap } {
  const total = totalmem();
  const free = freemem();
  return {
    memory: { total, used: total - free, app: null, wired: null, compressed: null, cached: null, pressure: null, availablePercent: (free / total) * 100 },
    swap: null,
  };
}

function readMemory(): Promise<{ memory: Memory; swap: Swap }> {
  const os = platform();
  if (os === "darwin") return macMemory();
  if (os === "linux") return linuxMemory();
  return Promise.resolve(genericMemory());
}

async function readDisk(): Promise<SystemStats["disk"]> {
  try {
    const stats = await statfs(homedir());
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

async function readBattery(): Promise<SystemStats["battery"]> {
  const os = platform();
  if (os === "darwin") {
    const text = await output("pmset", ["-g", "batt"]);
    // " -InternalBattery-0 (id=…)	85%; discharging; 4:12 remaining present: true"; desktops have no such line.
    const line = text.match(/InternalBattery[^\n]*?(\d+)%;\s*([^;]+);\s*([^\n]*)/);
    if (!line) return null;
    const time = line[3]?.match(/(\d+):(\d+)\s+remaining/);
    const minutesLeft = time ? Number(time[1]) * 60 + Number(time[2]) : null;
    return {
      percent: Number(line[1]),
      onBattery: /'Battery Power'/.test(text),
      state: line[2]!.trim(),
      // pmset reports 0:00 when charged or not estimating.
      minutesLeft: minutesLeft ? minutesLeft : null,
    };
  }
  if (os === "linux") {
    for (const name of ["BAT0", "BAT1"]) {
      const dir = `/sys/class/power_supply/${name}`;
      const [capacity, status] = await Promise.all([
        readFile(`${dir}/capacity`, "utf8").catch(() => null),
        readFile(`${dir}/status`, "utf8").catch(() => null),
      ]);
      if (capacity === null) continue;
      const state = (status ?? "unknown").trim().toLowerCase();
      return { percent: Number(capacity.trim()), onBattery: state === "discharging", state, minutesLeft: null };
    }
  }
  return null;
}

async function machineInfo(): Promise<{ name: string; groups: SystemStats["cpu"]["groups"] }> {
  const fallback = hostname().replace(/\.(local|lan|home)$/i, "");
  if (platform() !== "darwin") return { name: fallback, groups: [] };
  const [computerName, levels] = await Promise.all([
    output("scutil", ["--get", "ComputerName"]),
    output("sysctl", ["hw.nperflevels", ...[0, 1, 2, 3].flatMap((n) => [`hw.perflevel${n}.name`, `hw.perflevel${n}.logicalcpu`])]),
  ]);
  const ctl = keyValues(levels);
  const groups: SystemStats["cpu"]["groups"] = [];
  const count = int(ctl.get("hw.nperflevels")) ?? 0;
  for (let n = 0; n < Math.min(count, 4); n += 1) {
    const cores = int(ctl.get(`hw.perflevel${n}.logicalcpu`));
    if (cores) groups.push({ name: ctl.get(`hw.perflevel${n}.name`) || `Level ${n}`, cores });
  }
  return { name: computerName.trim() || fallback, groups: groups.length > 1 ? groups : [] };
}

function pushCapped(list: number[], value: number) {
  list.push(Math.round(value * 10) / 10);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
}

/** `ps` rows grouped by executable name. */
async function readProcesses(): Promise<SystemProcesses> {
  const sampledAt = Date.now();
  if (platform() === "win32") return { sampledAt, groups: [], error: "Process lists aren't read on Windows." };
  // -c: executable name only (macOS); Linux procps takes `comm` the same way.
  const text = await output("ps", platform() === "darwin" ? ["-Aco", "pcpu=,rss=,comm="] : ["-Ao", "pcpu=,rss=,comm="]);
  const groups = new Map<string, { name: string; count: number; cpu: number; memory: number }>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([\d.]+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    // macOS apps run as "<App> Helper (Renderer)" and the like: count them with their app.
    const name = match[3]!.replace(/ Helper(?: \([^)]*\))?$/, "");
    const group = groups.get(name) ?? { name, count: 0, cpu: 0, memory: 0 };
    group.count += 1;
    group.cpu += Number(match[1]);
    group.memory += Number(match[2]) * 1024;
    groups.set(name, group);
  }
  if (groups.size === 0) return { sampledAt, groups: [], error: "Couldn't read the process list." };
  const all = [...groups.values()];
  const top = new Set([
    ...[...all].sort((a, b) => b.cpu - a.cpu).slice(0, PROCESS_GROUPS_MAX / 2),
    ...[...all].sort((a, b) => b.memory - a.memory).slice(0, PROCESS_GROUPS_MAX / 2),
  ]);
  return { sampledAt, groups: [...top].map((group) => ({ ...group, cpu: Math.round(group.cpu * 10) / 10 })), error: null };
}

export function createSystemMonitor(bb: BbPluginApi) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastReadAt = 0;
  let previousCpu: CpuTimes | null = null;
  let previousSwap: { at: number; pagesIn: number; pagesOut: number } | null = null;
  let latest: SystemStats | null = null;
  let first: Promise<void> | null = null;
  let sampling = false;
  let battery: { at: number; value: SystemStats["battery"] } | null = null;
  let info: Promise<{ name: string; groups: SystemStats["cpu"]["groups"] }> | null = null;
  let processes: { at: number; value: Promise<SystemProcesses> } | null = null;
  const history = { cpu: [] as number[], memory: [] as number[], swapRate: [] as number[] };

  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const now = Date.now();
      const times = cpuTimes();
      const percent = previousCpu ? cpuPercent(previousCpu, times) : 0;
      previousCpu = times;
      info ??= machineInfo();
      const batteryDue = !battery || now - battery.at >= BATTERY_EVERY_MS;
      const [{ memory, swap }, disk, machine, batteryValue] = await Promise.all([
        readMemory(),
        readDisk(),
        info,
        batteryDue ? readBattery() : Promise.resolve(battery!.value),
      ]);
      if (batteryDue) battery = { at: now, value: batteryValue };

      let inPerSec: number | null = null;
      let outPerSec: number | null = null;
      if (swap && swap.pagesIn !== null && swap.pagesOut !== null) {
        if (previousSwap && now > previousSwap.at) {
          const seconds = (now - previousSwap.at) / 1000;
          inPerSec = (Math.max(0, swap.pagesIn - previousSwap.pagesIn) * swap.pageSize) / seconds;
          outPerSec = (Math.max(0, swap.pagesOut - previousSwap.pagesOut) * swap.pageSize) / seconds;
        }
        previousSwap = { at: now, pagesIn: swap.pagesIn, pagesOut: swap.pagesOut };
      }

      pushCapped(history.cpu, percent);
      pushCapped(history.memory, memory.total > 0 ? (memory.used / memory.total) * 100 : 0);
      pushCapped(history.swapRate, (inPerSec ?? 0) + (outPerSec ?? 0));
      const load = platform() === "win32" ? null : (loadavg() as [number, number, number]);
      latest = {
        name: machine.name,
        platform: platform(),
        uptimeSec: uptime(),
        sampledAt: now,
        intervalMs: SAMPLE_MS,
        cpu: { percent, cores: cpus().length, groups: machine.groups, load },
        memory,
        swap: swap ? { total: swap.total, used: swap.used, inPerSec, outPerSec } : null,
        disk,
        battery: batteryValue,
        history: { cpu: [...history.cpu], memory: [...history.memory], swapRate: [...history.swapRate] },
      };
    } catch (error) {
      bb.log.warn(`system sample failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      sampling = false;
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    first = null;
    latest = null;
    previousCpu = null;
    previousSwap = null;
    history.cpu.length = 0;
    history.memory.length = 0;
    history.swapRate.length = 0;
  }

  function start(): Promise<void> {
    previousCpu = cpuTimes();
    timer = setInterval(() => {
      if (Date.now() - lastReadAt > IDLE_STOP_MS) stop();
      else void sample();
    }, SAMPLE_MS);
    // A first figure soon, rather than a blank monitor for a whole interval.
    return new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_GAP_MS)).then(sample);
  }

  return {
    async stats(): Promise<SystemStats> {
      lastReadAt = Date.now();
      if (!timer) first = start();
      if (!latest) await first;
      if (!latest) await sample();
      if (!latest) throw new Error("Couldn't read this machine's resources.");
      return latest;
    },
    processes(): Promise<SystemProcesses> {
      const now = Date.now();
      if (!processes || now - processes.at >= PROCESSES_CACHE_MS) processes = { at: now, value: readProcesses() };
      return processes.value;
    },
    dispose: stop,
  };
}
