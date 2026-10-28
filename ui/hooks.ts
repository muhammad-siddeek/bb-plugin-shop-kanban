import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { errorMessage, type BoardState, type ReviewState } from "./model";

const BOARD_REFRESH_MS = 1000;
/** The review queue re-reads on the server's change signal; this clock only backs it up. */
const REVIEWS_POLL_MS = 60_000;

/** Runs `load` now, every `intervalMs` while the page is visible, and again whenever it becomes visible. */
function usePolling(load: () => void, intervalMs: number) {
  useEffect(() => {
    const loadIfVisible = () => {
      if (!document.hidden) load();
    };
    load();
    const timer = window.setInterval(loadIfVisible, intervalMs);
    document.addEventListener("visibilitychange", loadIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", loadIfVisible);
    };
  }, [load, intervalMs]);
}

export function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One read at a time so a slow host can't stack a read per tick; a refetch asked for mid-read runs after it.
  const read = useRef({ pending: false, again: false });

  const report = useCallback((cause: unknown) => setError(errorMessage(cause)), []);

  const refetch = useCallback(() => {
    const state = read.current;
    if (state.pending) {
      state.again = true;
      return;
    }
    Object.assign(state, { pending: true, again: false });
    rpc
      .call("board_list", null)
      .then((result) => {
        setBoard(result);
        setError(null);
      }, report)
      .finally(() => {
        state.pending = false;
        if (state.again) refetch();
      });
  }, [rpc, report]);

  usePolling(refetch, BOARD_REFRESH_MS);
  useRealtime("board-changed", refetch);

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
  /** Re-run the searches now. */
  refresh(): void;
  /** Marks read; resolves to the prompt that seeds a thread explaining the pull request. */
  draft(id: string): Promise<string>;
  markRead(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  submit(id: string, verdict: ReviewVerdict, body: string): Promise<void>;
};

export function useReviews(): ReviewsApi {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ReviewState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const receive = useCallback((next: ReviewState) => {
    setState(next);
    setError(null);
  }, []);
  const fail = useCallback((cause: unknown) => setError(errorMessage(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("reviews_list", null).then(receive, fail);
  }, [rpc, receive, fail]);

  usePolling(refetch, REVIEWS_POLL_MS);
  useRealtime("reviews-changed", refetch);

  return useMemo(
    () => ({
      state,
      error,
      refresh: () => {
        rpc.call("reviews_refresh", null).then(receive, fail);
      },
      draft: async (id: string) => (await rpc.call("reviews_draft", { id })).prompt,
      markRead: (id: string) => rpc.call("reviews_mark_read", { id }).then(() => {}),
      archive: (id: string) => rpc.call("reviews_archive", { id }).then(() => {}),
      submit: (id: string, verdict: ReviewVerdict, body: string) => rpc.call("reviews_submit", { id, verdict, body }).then(() => {}),
    }),
    [rpc, state, error, receive, fail],
  );
}
