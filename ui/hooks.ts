import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { BOARD_REFRESH_MS, type BoardState } from "./model";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useBoard() {
  const rpc = useRpc<any>();
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("board_list").then((result: BoardState) => {
      setBoard(result);
      setError(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refetch();
    const timer = window.setInterval(refetch, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  useRealtime("board-changed", refetch);
  useRealtime("board-task-status", refetch);

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

export function useTaskStatusNotifications() {
  useRealtime("board-task-status", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { column?: string; title?: string; note?: string };
    if (data.column !== "done" && data.column !== "blocked") return;
    console.info(`[${PLUGIN_SLUG}] ${data.title ?? "Task"} moved to ${data.column}`, data.note ?? "");
  });
}

export type BoardApi = ReturnType<typeof useBoard>;
