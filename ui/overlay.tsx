import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { PLUGIN_NAME } from "../brand";
import { ACCENT_TEXT, BOTTOM_BOARD_COLLAPSED_CLASS, BOTTOM_BOARD_HEIGHT_VAR, BOTTOM_BOARD_OPEN_CLASS, type BoardState, type BoardTask } from "./model";
import { useBoard, useRemote, useReviews, useWork, useRadar } from "./hooks";
import { IconButton, TYPE } from "./primitives";
import { BoardView } from "./column";
import { ThreadSearch } from "./search";
import { SystemMonitor } from "./system";
import { WorkingMeter } from "./wip-limit";

/** Shopify's bag (Simple Icons' `shopify` path), in white: the board's only mark in its title bar and pill. */
const SHOPIFY_BAG =
  "M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z";

function ShopifyMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={PLUGIN_NAME} className={`shrink-0 text-white ${className}`} fill="currentColor">
      <path d={SHOPIFY_BAG} />
    </svg>
  );
}

const DEFAULT_PANEL_MIN_HEIGHT = 320;
const PANEL_MIN_HEIGHT = 240;
/** Resize-handle keys and how far each moves the panel edge; Home/End jump to the limits. */
const KEY_STEPS: Partial<Record<string, number>> = {
  ArrowUp: 24,
  ArrowDown: -24,
  PageUp: 96,
  PageDown: -96,
  Home: -Infinity,
  End: Infinity,
};

function maxPanelHeight(): number {
  return Math.max(PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.9));
}

function clampPanelHeight(value: number): number {
  return Math.min(Math.max(value, PANEL_MIN_HEIGHT), maxPanelHeight());
}

/**
 * Right edge of bb's left sidebar, in px (0 when it is collapsed or hidden, e.g. on phones). The board is a
 * fixed bottom panel; starting it here instead of at the window's left edge keeps the sidebar's footer
 * (settings, etc.) reachable. bb's in-flow `[data-sidebar="gap"]` spacer always tracks the sidebar's width,
 * through collapse, rail mode, resizing and their animations.
 */
function useSidebarInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    let gap: Element | null = null;
    const observer = new ResizeObserver(() => measure());
    const measure = () => {
      if (!gap?.isConnected) {
        if (gap) observer.unobserve(gap);
        gap = document.querySelector('[data-sidebar="gap"]');
        if (gap) observer.observe(gap);
      }
      setInset(gap ? Math.max(0, Math.round(gap.getBoundingClientRect().right)) : 0);
    };
    // The sidebar can mount after this overlay or be replaced; re-find it when ours has left the page.
    const mutations = new MutationObserver(() => {
      if (!gap?.isConnected) measure();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return inset;
}

/**
 * The Working column's meter with blocked threads ahead of it, in the title bar and the pill; nothing while it'd be empty.
 * Waiting messages stay in the Working column's header only.
 */
function BoardStatus({ tasks, wipLimit }: { tasks: readonly BoardTask[]; wipLimit: BoardState["wipLimit"] | undefined }) {
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const working = tasks.filter((task) => task.status === "wip").length;
  if (blocked + working === 0) return null;
  return (
    <span className={`inline-flex shrink-0 items-center ${TYPE.badge} leading-none ${ACCENT_TEXT.amber}`}>
      <WorkingMeter limit={wipLimit?.limit ?? null} working={working} waiting={0} blocked={blocked} />
    </span>
  );
}

export function BottomBoardOverlay() {
  const [open, setOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(() =>
    clampPanelHeight(Math.max(DEFAULT_PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.48))),
  );
  const resizeCleanupRef = useRef<() => void>(() => {});
  const sidebarInset = useSidebarInset();
  const api = useBoard();
  const reviews = useReviews();
  const work = useWork();
  const remote = useRemote();
  const radar = useRadar();
  const { board } = api;
  const tasks = board?.tasks ?? [];

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
    const step = KEY_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setPanelHeight((height) => clampPanelHeight(height + step));
  };

  useEffect(() => () => resizeCleanupRef.current(), []);

  useEffect(() => {
    const handleResize = () => setPanelHeight((height) => clampPanelHeight(height));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Pads bb's page (see app.tsx) so the panel, or the phone's hidden-board bar, never covers its bottom.
  useEffect(() => {
    const root = document.documentElement;
    if (!open) {
      root.classList.add(BOTTOM_BOARD_COLLAPSED_CLASS);
      return () => root.classList.remove(BOTTOM_BOARD_COLLAPSED_CLASS);
    }
    root.classList.add(BOTTOM_BOARD_OPEN_CLASS);
    root.style.setProperty(BOTTOM_BOARD_HEIGHT_VAR, `${panelHeight}px`);
    return () => {
      root.classList.remove(BOTTOM_BOARD_OPEN_CLASS);
      root.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
    };
  }, [open, panelHeight]);

  if (!open) {
    // A floating pill; on phones a full-width bottom bar instead, in a strip app.tsx reserves, so it never
    // sits on bb's composer controls.
    return (
      <button
        type="button"
        className={`group fixed bottom-4 right-4 z-50 inline-flex h-9 cursor-pointer select-none items-center gap-2 rounded-full border border-border bg-card/90 pl-2 pr-2.5 ${TYPE.title} font-medium text-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35),0_2px_6px_-2px_rgba(0,0,0,0.15)] ring-1 ring-black/5 backdrop-blur-md transition-[transform,background-color,box-shadow] duration-150 ease-out hover:-translate-y-0.5 hover:bg-card hover:shadow-[0_12px_28px_-8px_rgba(0,0,0,0.4),0_2px_6px_-2px_rgba(0,0,0,0.15)] active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-[calc(2.75rem+env(safe-area-inset-bottom))] max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)] max-sm:pl-3.5 max-sm:pr-4 max-sm:shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.35)] max-sm:hover:translate-y-0 max-sm:active:scale-100`}
        onClick={() => setOpen(true)}
        aria-label={`Open ${PLUGIN_NAME} board`}
      >
        <ShopifyMark className="size-5" />
        <BoardStatus tasks={tasks} wipLimit={board?.wipLimit} />
        <Icon name="ChevronUp" className="size-3.5 text-muted-foreground transition-transform duration-150 group-hover:-translate-y-px group-hover:text-foreground max-sm:ml-auto max-sm:size-5" aria-hidden />
      </button>
    );
  }

  return (
    <div
      className="fixed right-0 bottom-0 z-50 flex flex-col border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.35),0_-1px_0_0_rgba(0,0,0,0.04)] backdrop-blur-md"
      style={{ height: `${panelHeight}px`, left: `${sidebarInset}px` }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${PLUGIN_NAME} board panel`}
        aria-valuemin={PANEL_MIN_HEIGHT}
        aria-valuemax={maxPanelHeight()}
        aria-valuenow={panelHeight}
        tabIndex={0}
        className="group absolute inset-x-0 -top-2 z-10 flex h-4 cursor-row-resize touch-none items-center justify-center focus:outline-none pointer-coarse:-top-3 pointer-coarse:h-6"
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/0 transition-colors duration-150 group-hover:bg-primary/30 group-focus-visible:bg-primary/50" />
        <span aria-hidden className="relative h-1 w-9 rounded-full bg-muted-foreground/30 transition-all duration-150 ease-out group-hover:w-14 group-hover:bg-primary/60 group-active:w-16 group-active:bg-primary group-focus-visible:w-14 group-focus-visible:bg-primary/70 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-background" />
      </div>

      {/* `relative`: on phones the search dropdown spans this bar instead of hanging off the search box. */}
      <div className="relative flex h-9 shrink-0 items-center gap-2 border-b border-border pl-[15px] pr-1.5 pointer-coarse:h-12 pointer-coarse:pr-1 max-sm:gap-1.5 max-sm:pr-1">
        <ShopifyMark className="size-4" />
        <BoardStatus tasks={tasks} wipLimit={board?.wipLimit} />
        <div className="ml-1 min-w-0 max-lg:ml-0 max-lg:flex-1">
          {/* Header (40px, 48px on touch) plus a little breathing room below the list. */}
          <ThreadSearch maxListHeight={panelHeight - 56} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <SystemMonitor maxPanelHeight={panelHeight - 56} />
          <IconButton icon="ChevronDown" label="Hide board" onClick={() => setOpen(false)} small className="size-7 rounded-md border border-border/70 pointer-coarse:size-9" />
        </div>
        {/* As wide as the columns' scrollbar gutter (nothing with overlay scrollbars), so the bar ends where the cards do. */}
        <span aria-hidden className="-ml-2 box-content h-px shrink-0 overflow-y-hidden [scrollbar-gutter:stable] [scrollbar-width:thin] max-sm:-ml-1.5" />
      </div>

      <div className="min-h-0 flex-1">
        <BoardView api={api} reviews={reviews} work={work} remote={remote} radar={radar} />
      </div>
    </div>
  );
}

