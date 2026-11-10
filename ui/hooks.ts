import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { errorMessage, type WorkMark } from "./model";

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

/** `usePoll`, also reading on the server's `channel` signal. */
function usePolledRead<T>(read: () => Promise<T>, intervalMs: number, channel: string) {
  const poll = usePoll(read, intervalMs);
  useRealtime(channel, poll.refetch);
  return poll;
}

export function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call("board_list", null), [rpc]);
  const { value: board, error, report, refetch } = usePolledRead(read, BOARD_REFRESH_MS, "board-changed");
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
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call("reviews_list", null), [rpc]);
  const { value: state, error } = usePolledRead(read, REVIEWS_POLL_MS, "reviews-changed");

  return useMemo(
    () => ({
      state,
      error,
      /** Marks read; resolves to the prompt that seeds a thread explaining the pull request. */
      draft: async (id: string) => (await rpc.call("reviews_draft", { id })).prompt,
      markRead: (id: string) => rpc.call("reviews_mark_read", { id }).then(() => {}),
      archive: (id: string) => rpc.call("reviews_archive", { id }).then(() => {}),
      submit: (id: string, verdict: ReviewVerdict, body: string) => rpc.call("reviews_submit", { id, verdict, body }).then(() => {}),
    }),
    [rpc, state, error],
  );
}

export type ReviewsApi = ReturnType<typeof useReviews>;

/** The work lists; `error` is why the last list read failed. */
export function useWork() {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call("work_list", null), [rpc]);
  const { value: state, error } = usePolledRead(read, REVIEWS_POLL_MS, "work-changed");
  return useMemo(
    () => ({ state, error, mark: (id: string, mark: WorkMark, on: boolean) => rpc.call("work_mark", { id, mark, on }).then(() => {}) }),
    [rpc, state, error],
  );
}

export type WorkApi = ReturnType<typeof useWork>;
