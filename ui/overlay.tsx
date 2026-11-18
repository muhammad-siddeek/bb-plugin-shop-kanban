import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { PLUGIN_NAME } from "../brand";
import { TOP_BOARD_ATTR, TOP_BOARD_CLASS, TOP_BOARD_INSET_VAR, type BoardTask } from "./model";
import { useBoard, useRemote, useReviews, useWork, useRadar } from "./hooks";
import { CountBadge, IconButton } from "./primitives";
import { COLUMN_INSET, ELEVATION, LEAD_INSET, STATUS_META, type Dropdown } from "./styles";
import { BoardView } from "./column";
import { ThreadSearch } from "./search";
import { SystemMonitor } from "./system";

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
const KEY_STEPS: Partial<Record<string, number>> = {
  ArrowDown: 24,
  ArrowUp: -24,
  PageDown: 96,
  PageUp: -96,
  Home: -Infinity,
  End: Infinity,
};
const BAR_ROW = "relative flex h-9 shrink-0 items-center gap-2 pr-1.5 pointer-coarse:h-12 pointer-coarse:pr-1 max-sm:gap-1.5 max-sm:pr-1";
const BAR_ROOM = 56;
// Under bb's floating sidebar toggle (z-44) and bb's menus and dialogs (z-50).
const BOARD_LAYER = "z-[43]";
const BOARD_MARK = { [TOP_BOARD_ATTR]: "" };

function maxPanelHeight(): number {
  return Math.max(PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.9));
}

function clampPanelHeight(value: number): number {
  return Math.min(Math.max(value, PANEL_MIN_HEIGHT), maxPanelHeight());
}

interface BbChrome {
  left: number;
  top: number;
  lead: number;
}

const CHROME_SELECTORS = {
  gap: '[data-sidebar="gap"]',
  titleBar: '[data-testid="app-window-title-bar"]',
  toggle: '[data-testid="app-sidebar-trigger-overlay"], [data-testid="app-desktop-sidebar-trigger"]',
} as const;

function useBbChrome(): BbChrome {
  const [chrome, setChrome] = useState<BbChrome>({ left: 0, top: 0, lead: 0 });
  useEffect(() => {
    const found: Record<keyof typeof CHROME_SELECTORS, Element | null> = { gap: null, titleBar: null, toggle: null };
    const keys = Object.keys(CHROME_SELECTORS) as (keyof typeof CHROME_SELECTORS)[];
    const measure = () => {
      const gap = found.gap?.getBoundingClientRect();
      const titleBar = found.titleBar?.getBoundingClientRect();
      const toggle = found.toggle?.getBoundingClientRect();
      const left = gap ? Math.max(0, Math.round(gap.right)) : 0;
      const top = titleBar ? Math.max(0, Math.round(titleBar.bottom)) : 0;
      const lead = toggle && toggle.width > 0 && toggle.bottom > top ? Math.max(0, Math.round(toggle.right) - left) : 0;
      setChrome((prev) => (prev.left === left && prev.top === top && prev.lead === lead ? prev : { left, top, lead }));
    };
    const observer = new ResizeObserver(measure);
    const refind = (): boolean => {
      let changed = false;
      for (const key of keys) {
        const current = found[key];
        if (current?.isConnected) continue;
        const next = document.querySelector(CHROME_SELECTORS[key]);
        if (next === current) continue;
        if (current) observer.unobserve(current);
        if (next) observer.observe(next);
        found[key] = next;
        changed = true;
      }
      return changed;
    };
    // At most once a frame: bb's page mutates on every streamed token.
    let frame = 0;
    const mutations = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (refind()) measure();
      });
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    refind();
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return chrome;
}

function BoardStatus({ tasks }: { tasks: readonly BoardTask[] }) {
  const working = tasks.filter((task) => task.status === "wip").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  if (working + blocked === 0) return null;
  const label = `${working} working, ${blocked} blocked`;
  return (
    <span title={label} className="inline-flex shrink-0">
      <span aria-hidden className="inline-flex items-center gap-1">
        <CountBadge count={working} tone={STATUS_META.wip.badge} />
        <CountBadge count={blocked} tone={STATUS_META.blocked.badge} />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function TopBoardOverlay() {
  const [open, setOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(() =>
    clampPanelHeight(Math.max(DEFAULT_PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.48))),
  );
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<() => void>(() => {});
  const chrome = useBbChrome();
  const api = useBoard();
  const reviews = useReviews();
  const work = useWork();
  const remote = useRemote();
  const radar = useRadar();
  const tasks = api.board?.tasks ?? [];

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
      setPanelHeight(clampPanelHeight(startHeight + moveEvent.clientY - startY));
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
    const handleResize = () => {
      setViewportHeight(window.innerHeight);
      setPanelHeight((height) => clampPanelHeight(height));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useLayoutEffect(() => {
    if (!root) return;
    const html = document.documentElement;
    const pad = () => html.style.setProperty(TOP_BOARD_INSET_VAR, `${chrome.top + root.offsetHeight}px`);
    const observer = new ResizeObserver(pad);
    observer.observe(root);
    pad();
    html.classList.add(TOP_BOARD_CLASS);
    return () => {
      observer.disconnect();
      html.classList.remove(TOP_BOARD_CLASS);
      html.style.removeProperty(TOP_BOARD_INSET_VAR);
    };
  }, [root, chrome.top]);

  const frame = { top: `${chrome.top}px`, left: `${chrome.left}px`, "--board-lead": `${chrome.lead}px` } as CSSProperties;
  const dropdown: Dropdown = open
    ? { side: "above", maxHeight: panelHeight - BAR_ROOM }
    : { side: "below", maxHeight: viewportHeight - chrome.top - BAR_ROOM };

  return (
    <div
      ref={setRoot}
      {...BOARD_MARK}
      className={`fixed right-0 ${BOARD_LAYER} flex flex-col border-b border-border bg-background/90 pt-[env(safe-area-inset-top)] ${ELEVATION.float} backdrop-blur-md`}
      style={open ? { ...frame, height: `${panelHeight}px` } : frame}
    >
      {open ? (
        <div className="min-h-0 flex-1">
          <BoardView api={api} reviews={reviews} work={work} remote={remote} radar={radar} />
        </div>
      ) : null}

      {/* Stays mounted while hidden, so a search in progress survives. */}
      <div className={`${BAR_ROW} ${open ? `border-t border-border ${COLUMN_INSET}` : LEAD_INSET}`}>
        <ShopifyMark className="size-4" />
        <BoardStatus tasks={tasks} />
        <div className="ml-1 min-w-0 max-lg:ml-0 max-lg:flex-1">
          <ThreadSearch dropdown={dropdown} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <SystemMonitor dropdown={dropdown} />
          <IconButton icon={open ? "ChevronUp" : "ChevronDown"} label={open ? "Hide board" : "Show board"} onClick={() => setOpen(!open)} />
        </div>
        {/* Matches the columns' scrollbar gutter, so the bar ends where the cards do. */}
        <span aria-hidden className="-ml-2 box-content h-px shrink-0 overflow-y-hidden [scrollbar-gutter:stable] [scrollbar-width:thin] max-sm:-ml-1.5" />
      </div>

      {open ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${PLUGIN_NAME} board panel`}
          aria-valuemin={PANEL_MIN_HEIGHT}
          aria-valuemax={maxPanelHeight()}
          aria-valuenow={panelHeight}
          tabIndex={0}
          className="group absolute inset-x-0 -bottom-2 z-10 flex h-4 cursor-row-resize touch-none items-center justify-center [app-region:no-drag] [-webkit-app-region:no-drag] focus:outline-none pointer-coarse:-bottom-3 pointer-coarse:h-6"
          onPointerDown={startResize}
          onKeyDown={handleResizeKeyDown}
        >
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors duration-150 group-hover:bg-muted-foreground/50 group-focus-visible:bg-muted-foreground/50" />
          <span aria-hidden className="relative h-1 w-9 rounded-full bg-muted-foreground/50 transition-all duration-150 ease-out group-hover:w-14 group-hover:bg-muted-foreground group-active:w-16 group-focus-visible:w-14 group-focus-visible:bg-muted-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring/60 group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-background" />
        </div>
      ) : null}
    </div>
  );
}

