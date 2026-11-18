import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc, type NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { errorMessage, type RemoteState, type WorkMark } from "./model";
import type { RadarState } from "../server/radar-schema";

const BOARD_REFRESH_MS = 1000;
/** The review queue and work lists re-read on the server's change signal; this clock only backs it up. */
const REVIEWS_POLL_MS = 60_000;
const READ_STALL_MS = 60_000;
const STALLED = "The plugin server is not answering; still retrying.";

/**
 * One `read` at a time, so a slow server can't stack a request per tick; a call made mid-read runs once it
 * ends. A read that never settles fails after `stallMs` with `stallMessage`, so polling carries on.
 */
function singleFlight<T>(
  read: () => Promise<T>,
  receive: (value: T) => void,
  fail: (cause: unknown) => void,
  stallMs: number,
  stallMessage: string,
): () => void {
  let pending = false;
  let again = false;
  const run = () => {
    if (pending) {
      again = true;
      return;
    }
    pending = true;
    again = false;
    let timer = 0;
    const stalled = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(stallMessage)), stallMs);
    });
    Promise.race([read(), stalled])
      .then(receive, fail)
      .finally(() => {
        window.clearTimeout(timer);
        pending = false;
        if (again) run();
      });
  };
  return run;
}

/**
 * Keeps the latest `read` result: reads now, every `intervalMs` while the page is visible, and when it becomes
 * visible again. `read` must be stable.
 */
export function usePoll<T>(read: () => Promise<T>, intervalMs: number, stallMs = READ_STALL_MS, stallMessage = STALLED) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const receive = useCallback((next: T) => {
    setValue(next);
    setError(null);
  }, []);
  const report = useCallback((cause: unknown) => setError(errorMessage(cause)), []);
  const refetch = useMemo(() => singleFlight(read, receive, report, stallMs, stallMessage), [read, receive, report, stallMs, stallMessage]);

  useEffect(() => {
    const refetchIfVisible = () => {
      if (!document.hidden) refetch();
    };
    refetch();
    const timer = window.setInterval(refetchIfVisible, intervalMs);
    document.addEventListener("visibilitychange", refetchIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [refetch, intervalMs]);
  return { value, error, report, refetch };
}

type ListMethod = "board_list" | "reviews_list" | "work_list" | "remote_list" | "radar_list";

/** One of the server's lists: `usePoll` on its `method`, also reading on the server's `channel` signal. */
function useServerList<Method extends ListMethod>(method: Method, intervalMs: number, channel: string) {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call(method, null), [rpc, method]);
  const poll = usePoll(read, intervalMs);
  useRealtime(channel, poll.refetch);
  return { rpc, ...poll };
}

/**
 * Changes shown before the server's next read agrees: one value per id, each dropped once `pending(value, id, state)`
 * says the server caught up (or the item left). `change` sets an id's value from its current one; undefined drops it.
 */
export function usePending<State, Value>(state: State | null, pending: (value: Value, id: string, state: State) => boolean) {
  const [values, setValues] = useState<ReadonlyMap<string, Value>>(() => new Map());
  useEffect(() => {
    if (!state) return;
    setValues((current) => {
      const next = new Map([...current].filter(([id, value]) => pending(value, id, state)));
      return next.size === current.size ? current : next;
    });
    // `pending` is a pure test written inline: only the server's state changes its answer.
  }, [state]);
  const change = useCallback((id: string, update: (value: Value | undefined) => Value | undefined) => {
    setValues((current) => {
      const before = current.get(id);
      const after = update(before);
      if (after === before) return current;
      const next = new Map(current);
      if (after === undefined) next.delete(id);
      else next.set(id, after);
      return next;
    });
  }, []);
  return [values, change] as const;
}

export function useBoard() {
  const { rpc, value: board, error, report, refetch } = useServerList("board_list", BOARD_REFRESH_MS, "board-changed");
  return { rpc, board, error, report, refetch };
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type BoardApi = ReturnType<typeof useBoard>;

export type ReviewVerdict = "approve" | "request_changes";

/** The review queue; `error` is why the last list read failed. */
export function useReviews() {
  const { rpc, value: state, error } = useServerList("reviews_list", REVIEWS_POLL_MS, "reviews-changed");

  return useMemo(
    () => ({
      state,
      error,
      /** Marks read; resolves to the prompt that seeds a thread explaining the pull request. */
      draft: async (id: string) => (await rpc.call("reviews_draft", { id })).prompt,
      markRead: (id: string) => rpc.call("reviews_mark_read", { id }),
      archive: (id: string) => rpc.call("reviews_archive", { id }),
      submit: (id: string, verdict: ReviewVerdict, body: string) => rpc.call("reviews_submit", { id, verdict, body }),
    }),
    [rpc, state, error],
  );
}

export type ReviewsApi = ReturnType<typeof useReviews>;

/** The work lists; `error` is why the last list read failed. */
export function useWork() {
  const { rpc, value: state, error } = useServerList("work_list", REVIEWS_POLL_MS, "work-changed");
  return useMemo(
    () => ({ state, error, mark: (id: string, mark: WorkMark, on: boolean) => rpc.call("work_mark", { id, mark, on }) }),
    [rpc, state, error],
  );
}

export type WorkApi = ReturnType<typeof useWork>;

/** The Working column's Remote section: live River sessions and Torrent tickets; `error` is why the last read failed. */
export type RemoteApi = { state: RemoteState | null; error: string | null };

export function useRemote(): RemoteApi {
  const { value: state, error } = useServerList("remote_list", REVIEWS_POLL_MS, "remote-changed");
  return useMemo(() => ({ state, error }), [state, error]);
}

export function useRadar(): RadarApi {
  const { rpc, value: state, error, refetch } = useServerList("radar_list", REVIEWS_POLL_MS, "radar-changed");
  return useMemo(() => ({
    state, error, refetch,
    refresh: async () => { try { await rpc.call("radar_execute", { action: "scan" }); } finally { refetch(); } },
    draft: (id: string) => rpc.call("radar_draft", { id }),
    dismiss: async (id: string) => { await rpc.call("radar_dismiss", { id }); refetch(); },
    openTechnique: async (id: string) => { await rpc.call("radar_open_technique", { id }); refetch(); },
    submit: async (id: string, request: NewThreadRequest) => {
      const result = await rpc.call("radar_submit", { id, composer: { ...request } });
      refetch();
      return result;
    },
  }), [rpc, state, error, refetch]);
}

export interface RadarApi {
  state: RadarState | null;
  error: string | null;
  refetch: () => void;
  refresh: () => Promise<void>;
  draft: (id: string) => Promise<{ prompt: string }>;
  dismiss: (id: string) => Promise<void>;
  openTechnique: (id: string) => Promise<void>;
  submit: (id: string, request: NewThreadRequest) => Promise<{ threadId: string }>;
}
