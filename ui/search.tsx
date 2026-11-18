import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/schema";
import { CLOCK_TICK_MS, errorMessage, type SearchResponse } from "./model";
import { useNow } from "./hooks";
import { Age, Spinner, useOutsideClose } from "./primitives";
import { ACCENT_TEXT, CHIP, ICON_ACTION, POPOVER, POPOVER_SIDE, TYPE, type Dropdown } from "./styles";

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Title-bar search over every thread qmd has indexed, archived included. Picking a result only opens
 * the thread in bb: it never reads, moves, adds or unarchives anything on the board.
 */
export function ThreadSearch({ dropdown }: { dropdown: Dropdown }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow(CLOCK_TICK_MS);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // Results belong only to the current query; never offer an old match while the next search is pending.
  const [answer, setAnswer] = useState<{ query: string; response: SearchResponse } | null>(null);
  // One search at a time: a slow qmd can't stack a request per pause in typing.
  const [inFlight, setInFlight] = useState(false);
  const [active, setActive] = useState(0);
  const trimmed = query.trim();
  const response = trimmed && answer?.query === trimmed ? answer.response : null;
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

  useOutsideClose(rootRef, open, () => setOpen(false));

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
    if (event.key === "Enter" && open) {
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
    // Phones: `static`, so the dropdown spans the whole title bar (the overlay's positioned row) and stays on screen.
    <div ref={rootRef} className="relative min-w-0 max-sm:static">
      <div className="flex h-7 w-56 items-center gap-1.5 rounded-md border border-border bg-muted/50 pl-2 pr-1 transition-[box-shadow,background-color] focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/60 lg:w-72 max-lg:w-full pointer-coarse:h-9">
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
          // 16px on touch: iOS zooms the page into any smaller input that takes focus.
          className={`h-full min-w-0 flex-1 bg-transparent ${TYPE.body} text-foreground outline-none placeholder:text-muted-foreground/80 [&::-webkit-search-cancel-button]:hidden pointer-coarse:text-base`}
        />
        {pending ? <Spinner /> : null}
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              changeQuery("");
              inputRef.current?.focus();
            }}
            className={ICON_ACTION.neutral}
          >
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>

      {open && trimmed ? (
        <div
          className={`${POPOVER} ${POPOVER_SIDE[dropdown.side]} left-0 w-[min(30rem,calc(100vw-2rem))]`}
          style={{ maxHeight: `${Math.max(dropdown.maxHeight, 120)}px` }}
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
                  className={`cursor-pointer rounded-md px-2 py-1.5 transition-colors ${index === active ? "bg-accent text-accent-foreground" : ""}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate ${TYPE.title} font-semibold leading-[18px]`}>{result.title}</span>
                    {result.archived ? (
                      <span className={`${CHIP} gap-1 bg-muted text-muted-foreground`}>
                        <Icon name="Archive" className="size-2.5" aria-hidden />
                        Archived
                      </span>
                    ) : null}
                    <Age at={result.updatedAt} now={now} className={`shrink-0 ${TYPE.meta} tabular-nums text-muted-foreground/80`} />
                  </div>
                  {result.snippet ? (
                    <p className={`mt-0.5 line-clamp-2 ${TYPE.meta} leading-[14px] text-muted-foreground`}>{result.snippet}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {status || error ? (
            <div
              role="status"
              aria-live="polite"
              className={`flex shrink-0 items-start gap-1.5 px-3 py-2 ${TYPE.meta} leading-[14px] ${results.length > 0 ? "border-t border-border/60" : ""}`}
            >
              {error ? (
                <>
                  <Icon name="AlertCircle" className={`size-3.5 shrink-0 ${ACCENT_TEXT.rose}`} aria-hidden />
                  <span className={`min-w-0 ${ACCENT_TEXT.rose}`}>{error}</span>
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
