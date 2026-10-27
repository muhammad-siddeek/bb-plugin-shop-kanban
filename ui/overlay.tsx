import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { PLUGIN_NAME } from "../brand";
import {
  BOTTOM_BOARD_HEIGHT_VAR,
  BOTTOM_BOARD_OPEN_CLASS,
  COLUMN_META,
  PANEL_KEYBOARD_LARGE_STEP,
  PANEL_KEYBOARD_STEP,
  PANEL_MIN_HEIGHT,
  PLUGIN_ICON,
  clampPanelHeight,
  defaultPanelHeight,
  maxPanelHeight,
} from "./model";
import { useBoard, useTaskStatusNotifications } from "./hooks";
import { IconButton } from "./primitives";
import { BoardView } from "./column";
import { ThreadSearch } from "./search";

/** Height updater for a resize-handle key, or null when the key does not resize the panel. */
function keyboardResize(key: string): ((height: number) => number) | null {
  switch (key) {
    case "ArrowUp":
      return (height) => clampPanelHeight(height + PANEL_KEYBOARD_STEP);
    case "ArrowDown":
      return (height) => clampPanelHeight(height - PANEL_KEYBOARD_STEP);
    case "PageUp":
      return (height) => clampPanelHeight(height + PANEL_KEYBOARD_LARGE_STEP);
    case "PageDown":
      return (height) => clampPanelHeight(height - PANEL_KEYBOARD_LARGE_STEP);
    case "Home":
      return () => PANEL_MIN_HEIGHT;
    case "End":
      return () => maxPanelHeight();
    default:
      return null;
  }
}

function CountBadge({ column, count }: { column: "blocked" | "done"; count: number }) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide tabular-nums ${COLUMN_META[column].badge}`}>
      {count} {column}
    </span>
  );
}

export function BottomBoardOverlay() {
  const [open, setOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(defaultPanelHeight);
  const resizeCleanupRef = useRef<() => void>(() => {});
  const api = useBoard();
  const { board, refetch } = api;
  useTaskStatusNotifications();
  const blockedTasks = board?.tasks.filter((task) => task.column === "blocked").length ?? 0;
  const doneTasks = board?.tasks.filter((task) => task.column === "done").length ?? 0;
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimerRef = useRef<number | undefined>(undefined);

  const handleRefresh = () => {
    refetch();
    setRefreshing(true);
    window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => setRefreshing(false), 1000);
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current();

    const startY = event.clientY;
    const startHeight = panelHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      setPanelHeight(clampPanelHeight(startHeight + startY - moveEvent.clientY));
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = () => {};
    };

    resizeCleanupRef.current = stopResize;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const resize = keyboardResize(event.key);
    if (!resize) return;
    event.preventDefault();
    setPanelHeight(resize);
  };

  useEffect(() => {
    return () => {
      window.clearTimeout(refreshTimerRef.current);
      resizeCleanupRef.current();
    };
  }, []);

  useEffect(() => {
    const handleResize = () => setPanelHeight((height) => clampPanelHeight(height));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add(BOTTOM_BOARD_OPEN_CLASS);
    return () => root.classList.remove(BOTTOM_BOARD_OPEN_CLASS);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.style.setProperty(BOTTOM_BOARD_HEIGHT_VAR, `${panelHeight}px`);
    return () => {
      root.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
    };
  }, [open, panelHeight]);

  if (!open) {
    return (
      <button
        type="button"
        className="group fixed bottom-4 right-4 z-50 inline-flex h-9 cursor-pointer select-none items-center gap-2 rounded-full border border-border bg-card/90 pl-2 pr-2.5 text-[13px] font-medium text-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35),0_2px_6px_-2px_rgba(0,0,0,0.15)] ring-1 ring-black/5 backdrop-blur-md transition-[transform,background-color,box-shadow] duration-150 ease-out hover:-translate-y-0.5 hover:bg-card hover:shadow-[0_12px_28px_-8px_rgba(0,0,0,0.4),0_2px_6px_-2px_rgba(0,0,0,0.15)] active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
        aria-label={`Open ${PLUGIN_NAME} board`}
        title={`Open ${PLUGIN_NAME} board`}
      >
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
          <Icon name={PLUGIN_ICON} className="size-3.5" aria-hidden />
        </span>
        <span className="tracking-tight">{PLUGIN_NAME}</span>
        <CountBadge column="blocked" count={blockedTasks} />
        <CountBadge column="done" count={doneTasks} />
        <Icon name="ChevronUp" className="size-3.5 text-muted-foreground transition-transform duration-150 group-hover:-translate-y-px group-hover:text-foreground" aria-hidden />
      </button>
    );
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-background/95 shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.35),0_-1px_0_0_rgba(0,0,0,0.04)] backdrop-blur-md"
      style={{ height: `${panelHeight}px` }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${PLUGIN_NAME} board panel`}
        aria-valuemin={PANEL_MIN_HEIGHT}
        aria-valuemax={maxPanelHeight()}
        aria-valuenow={panelHeight}
        tabIndex={0}
        className="group absolute inset-x-0 -top-2 z-10 flex h-4 cursor-row-resize touch-none items-center justify-center focus:outline-none"
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
        title="Drag to resize"
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/0 transition-colors duration-150 group-hover:bg-primary/30 group-focus-visible:bg-primary/50" />
        <span aria-hidden className="relative h-1 w-9 rounded-full bg-muted-foreground/30 transition-all duration-150 ease-out group-hover:w-14 group-hover:bg-primary/60 group-active:w-16 group-active:bg-primary group-focus-visible:w-14 group-focus-visible:bg-primary/70 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-background" />
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border/60 pl-3.5 pr-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
            <Icon name={PLUGIN_ICON} className="size-3.5" aria-hidden />
          </span>
          <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">{PLUGIN_NAME}</span>
        </div>
        {board ? (
          <span className="hidden items-center gap-2.5 text-xs tabular-nums text-muted-foreground sm:inline-flex">
            <span aria-hidden className="h-3.5 w-px bg-border" />
            {board.tasks.length} thread{board.tasks.length === 1 ? "" : "s"}
          </span>
        ) : null}
        <CountBadge column="blocked" count={blockedTasks} />
        <div className="ml-3 min-w-0">
          {/* Header (40px) plus a little breathing room below the list. */}
          <ThreadSearch maxListHeight={panelHeight - 56} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon="ArrowReloadHorizontal"
            label="Refresh board"
            onClick={handleRefresh}
            className={refreshing ? "text-foreground [&_svg]:animate-spin" : ""}
          />
          <IconButton icon="ChevronDown" label="Hide board" onClick={() => setOpen(false)} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <BoardView api={api} />
      </div>
    </div>
  );
}

