import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { errorMessage, type ReviewState } from "./model";

const BOARD_REFRESH_MS = 1000;
/** The review queue re-reads on the server's change signal; this clock only backs it up. */
const REVIEWS_POLL_MS = 60_000;
const READ_STALL_MS = 60_000;

/**
 * One `read` at a time, so a slow server can't stack a request per tick; a call made mid-read runs once it
 * ends. A read that never settles fails after READ_STALL_MS, so polling carries on.
 */
function singleFlight<T>(read: () => Promise<T>, receive: (value: T) => void, fail: (cause: unknown) => void): () => void {
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
      timer = window.setTimeout(() => reject(new Error("The plugin server is not answering; still retrying.")), READ_STALL_MS);
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
 * Keeps the latest `read` result: reads now, every `intervalMs` while the page is visible, when it becomes
 * visible again, and on the server's `channel` signal. `read` must be stable.
 */
function usePolledRead<T>(read: () => Promise<T>, intervalMs: number, channel: string) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const receive = useCallback((next: T) => {
    setValue(next);
    setError(null);
  }, []);
  const report = useCallback((cause: unknown) => setError(errorMessage(cause)), []);
  const refetch = useMemo(() => singleFlight(read, receive, report), [read, receive, report]);

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
  useRealtime(channel, refetch);

  return { value, error, report, refetch };
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

export type ReviewsApi = {
  state: ReviewState | null;
  /** Why the last list read failed. */
  error: string | null;
  /** Marks read; resolves to the prompt that seeds a thread explaining the pull request. */
  draft(id: string): Promise<string>;
  markRead(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  submit(id: string, verdict: ReviewVerdict, body: string): Promise<void>;
};

export function useReviews(): ReviewsApi {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call("reviews_list", null), [rpc]);
  const { value: state, error } = usePolledRead(read, REVIEWS_POLL_MS, "reviews-changed");

  return useMemo(
    () => ({
      state,
      error,
      draft: async (id: string) => (await rpc.call("reviews_draft", { id })).prompt,
      markRead: (id: string) => rpc.call("reviews_mark_read", { id }).then(() => {}),
      archive: (id: string) => rpc.call("reviews_archive", { id }).then(() => {}),
      submit: (id: string, verdict: ReviewVerdict, body: string) => rpc.call("reviews_submit", { id, verdict, body }).then(() => {}),
    }),
    [rpc, state, error],
  );
}
