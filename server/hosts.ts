import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { safe } from "./text";

/**
 * The first connected bb host; null when none is connected or the list is unreadable. A disconnected host would only
 * hold the call until its timeout.
 */
export async function connectedHostId(bb: BbPluginApi): Promise<string | null> {
  const list = (await safe(async () => bb.sdk.hosts.list())) ?? [];
  return list.find((entry) => entry.status === "connected")?.id ?? null;
}

/**
 * The host that keeps the search index: `current` while it stays connected, else the first connected persistent
 * host. Sticking to one host avoids re-exporting every thread when bb lists hosts in another order; ephemeral
 * hosts are skipped because their files go away with them. Null when no such host is connected.
 */
export async function indexHostId(bb: BbPluginApi, current: string | null): Promise<string | null> {
  const connected = ((await safe(async () => bb.sdk.hosts.list())) ?? []).filter((entry) => entry.status === "connected");
  if (current && connected.some((entry) => entry.id === current)) return current;
  return connected.find((entry) => entry.type === "persistent")?.id ?? null;
}

/**
 * Whether a host command error means the CLI could not start: Node reports `spawn x ENOENT`, Bun
 * `Executable not found in $PATH: "x"`, and a shell `x: command not found`.
 */
export function commandMissing(error: string): boolean {
  return /ENOENT|not found in \$PATH|command not found/i.test(error);
}
