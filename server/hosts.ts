import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { safe } from "./text";
import { rows } from "./threads";

/** The first connected bb host (any host when none is connected); null when the list is empty or unreadable. */
export async function connectedHostId(bb: BbPluginApi): Promise<string | null> {
  const list = rows(await safe(async () => bb.sdk.hosts.list()), "hosts");
  return list.find((entry) => entry?.status === "connected")?.id ?? list[0]?.id ?? null;
}

/**
 * The host that keeps the search index: `current` while it stays connected, else the first connected persistent
 * host. Sticking to one host avoids re-exporting every thread when bb lists hosts in another order; ephemeral
 * hosts are skipped because their files go away with them. Null when no such host is connected.
 */
export async function indexHostId(bb: BbPluginApi, current: string | null): Promise<string | null> {
  const connected = rows(await safe(async () => bb.sdk.hosts.list()), "hosts").filter((entry) => entry?.status === "connected");
  if (current && connected.some((entry) => entry.id === current)) return current;
  return connected.find((entry) => entry.type === "persistent")?.id ?? null;
}
