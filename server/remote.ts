import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RemoteItem, RemoteSource } from "../contract";
import { CALL_TIMEOUT_MS, createPoller } from "./forge-search";
import { hostClient, indexHostId } from "./hosts";
import type { RemoteState } from "./schema";
import { coalesced, errorMessage } from "./text";

// The Working column's Remote section: the user's live River sessions and Torrent tickets, read on their persistent
// host with its gcloud identity (host/remote.ts). Polled like the pull request lists.

const NO_HOST = "No connected persistent host to read River and Torrent on.";
const SOURCES: RemoteSource["source"][] = ["torrent", "river"];

export function createRemoteWork(bb: BbPluginApi) {
  const host = hostClient(bb);
  const changed = coalesced(() => bb.realtime.publish("remote-changed", { at: Date.now() }), 300);
  let items: RemoteItem[] = [];
  let sources: RemoteSource[] = [];
  let hostId: string | null = null;
  const poller = createPoller(runRefresh, changed, 5_000);

  async function runRefresh(): Promise<boolean> {
    hostId = await indexHostId(bb, hostId);
    const target = hostId;
    if (!target) {
      // Quiet like a missing CLI; the last items stay up until a host connects again.
      sources = SOURCES.map((source) => ({ source, error: NO_HOST, missing: true }));
      return true;
    }
    const result = await host
      .call("remote_work", {}, { hostId: target, timeoutMs: CALL_TIMEOUT_MS })
      .catch((cause: unknown) => ({ items: [], sources: SOURCES.map((source) => ({ source, error: errorMessage(cause), missing: false })) }));
    // A source that failed keeps what it listed last time instead of flickering it away.
    const failed = new Set(result.sources.flatMap((source) => (source.error === null ? [] : [source.source])));
    items = [...result.items, ...items.filter((item) => failed.has(item.source))].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    sources = result.sources;
    return result.sources.some((source) => source.error !== null && !source.missing);
  }

  function list(): RemoteState {
    poller.readFresh();
    return { items, sources, refreshing: poller.refreshing, refreshedAt: poller.refreshedAt, error: poller.error };
  }

  function dispose() {
    poller.dispose();
    changed.cancel();
  }

  return { list, dispose };
}
