import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { CLOCK_TICK_MS, errorMessage, formatRelativeTime, type SearchResponse } from "./model";
import { useNow } from "./hooks";

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Title-bar search over every thread qmd has indexed, archived included. Picking a result only opens
 * the thread in bb: it never reads, moves, adds or unarchives anything on the board.
 */
export function ThreadSearch({ maxListHeight }: { maxListHeight: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow(CLOCK_TICK_MS);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // The last answer and the query it answers; while a newer query waits, its results stay up.
  const [answer, setAnswer] = useState<{ query: string; response: SearchResponse } | null>(null);
  // One search at a time: a slow qmd can't stack a request per pause in typing.
  const [inFlight, setInFlight] = useState(false);
  const [active, setActive] = useState(0);
  const trimmed = query.trim();
  const response = trimmed ? answer?.response ?? null : null;
  const results = response?.results ?? [];
  const pending = trimmed !== "" && answer?.query !== trimmed;

  const changeQuery = (value: string) => {
    setQuery(value);
    if (!value.trim()) setAnswer(null);
  };

  useEffect(() => {
    if (!pending || inFlight) return;
    const timer = window.setTimeout(() => {
      setInFlight(true);
      rpc
        .call("board_search", { query: trimmed })
        .catch((cause: unknown): SearchResponse => ({ results: [], indexed: 0, indexing: false, error: errorMessage(cause) }))
        .then((next) => {
          setAnswer({ query: trimmed, response: next });
          setActive(0);
          setInFlight(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [rpc, trimmed, pending, inFlight]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const select = (threadId: string) => {
    setOpen(false);
    inputRef.current?.blur();
    navigate.toThread(threadId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (open && trimmed) setOpen(false);
      else {
        changeQuery("");
        inputRef.current?.blur();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      const result = results[active] ?? results[0];
      if (!result) return;
      event.preventDefault();
      select(result.threadId);
    }
  };

  const error = response?.error ?? null;
  let status: string | null = null;
  if (pending && results.length === 0) status = "Searching…";
  else if (response?.indexing) status = `Indexing threads… ${response.indexed} so far`;
  else if (response && results.length === 0) status = "No threads match";
  const activeResult = open ? results[active] : undefined;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="flex h-7 w-56 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 pl-2 pr-1 transition-[border-color,box-shadow,background-color] focus-within:border-ring/60 focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/20 md:w-72">
        <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search threads, archived included"
          aria-expanded={open && trimmed.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeResult ? `${listId}-${activeResult.threadId}` : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={(event) => {
            changeQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search threads…"
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 [&::-webkit-search-cancel-button]:hidden"
        />
        {pending ? (
          <span className="inline-flex size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/25 border-t-muted-foreground/80" aria-hidden />
        ) : null}
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              changeQuery("");
              inputRef.current?.focus();
            }}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>

      {open && trimmed ? (
        <div
          className="absolute left-0 top-full z-30 mt-1.5 flex w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] ring-1 ring-black/5"
          style={{ maxHeight: `${Math.max(maxListHeight, 120)}px` }}
        >
          {results.length > 0 ? (
            <ul id={listId} role="listbox" aria-label="Matching threads" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]">
              {results.map((result, index) => (
                <li
                  key={result.threadId}
                  id={`${listId}-${result.threadId}`}
                  role="option"
                  aria-selected={index === active}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => select(result.threadId)}
                  className={`cursor-pointer rounded-lg px-2.5 py-2 transition-colors ${index === active ? "bg-accent text-accent-foreground" : ""}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-[18px]">{result.title}</span>
                    {result.archived ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground">
                        <Icon name="Archive" className="size-2.5" aria-hidden />
                        Archived
                      </span>
                    ) : null}
                    {result.updatedAt !== null ? (
                      <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/80">{formatRelativeTime(result.updatedAt, now)}</span>
                    ) : null}
                  </div>
                  {result.snippet ? (
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{result.snippet}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {status || error ? (
            <div
              role="status"
              aria-live="polite"
              className={`flex shrink-0 items-start gap-1.5 px-3 py-2 text-[11px] leading-snug ${results.length > 0 ? "border-t border-border/60" : ""}`}
            >
              {error ? (
                <>
                  <Icon name="AlertCircle" className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
                  <span className="min-w-0 text-destructive">{error}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{status}</span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
