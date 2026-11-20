import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { CountBadge } from "./primitives";
import { ACCENT_TEXT, BOARD_PALETTE, ELEVATION, STATUS_META, TYPE } from "./styles";

const LIMIT_CHOICES = [0, 1, 2, 3, 4, 5];
/** The menu's gap from the picker, and its least room from the viewport's edges. */
const MENU_GAP = 6;
const MENU_MARGIN = 8;

type Placement = { right: number; top?: number; bottom?: number; maxHeight: number };

/**
 * The Working column's limit picker, in the column's amber: the limit, opening a menu of choices, after a
 * queued-colored count of threads waiting for a slot. The working count is the column header's badge.
 */
export function WipLimitControl({ limit, working, waiting, onChange }: {
  limit: number | null;
  /** Working cards holding a slot: not Blocked. */
  working: number;
  waiting: number;
  onChange: (limit: number | null) => void;
}) {
  // A limit set elsewhere (the RPC takes 0 to 50) still shows as the selected choice.
  const numbers = limit === null || LIMIT_CHOICES.includes(limit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, limit].sort((a, b) => a - b);
  const choices: (number | null)[] = [...numbers, null];
  const label = [
    limit === null ? `${working} working, no limit` : `${working} of ${limit} working${working > limit ? `, ${working - limit} over the limit` : ""}`,
    waiting ? `${waiting} waiting` : null,
  ].filter(Boolean).join(", ");

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (choice: number | null) => {
    close(true);
    if (choice !== limit) onChange(choice);
  };
  const openMenu = () => {
    setActive(Math.max(0, choices.indexOf(limit)));
    setOpen(true);
  };

  // Below the picker, or above it when there is more room there; right edges aligned. The menu lives in a portal
  // because the column header clips what overflows it.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(MENU_MARGIN, window.innerWidth - rect.right);
    const below = window.innerHeight - rect.bottom - MENU_GAP - MENU_MARGIN;
    const above = rect.top - MENU_GAP - MENU_MARGIN;
    setPlacement(
      below >= 200 || below >= above
        ? { right, top: rect.bottom + MENU_GAP, maxHeight: below }
        : { right, bottom: window.innerHeight - rect.top + MENU_GAP, maxHeight: above },
    );
    menuRef.current?.focus();
  }, [open]);

  // Outside presses, scrolling and resizing close it: its place follows the picker only when it opens.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) || buttonRef.current?.contains(target));
    const pressOutside = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const moved = (event: Event) => {
      if (!inside(event.target)) close(false);
    };
    const resized = () => close(false);
    document.addEventListener("pointerdown", pressOutside);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", pressOutside);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", resized);
    };
  }, [open]);

  const onMenuKey = (event: KeyboardEvent) => {
    const last = choices.length - 1;
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((index) => (index >= last ? 0 : index + 1)),
      ArrowUp: () => setActive((index) => (index <= 0 ? last : index - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => choose(choices[active]),
      " ": () => choose(choices[active]),
      Escape: () => close(true),
      Tab: () => close(false),
    };
    const action = keys[event.key];
    if (!action) return;
    if (event.key !== "Tab") event.preventDefault();
    event.stopPropagation();
    action();
  };

  const optionText = (choice: number | null) => (choice === null ? "No limit" : `Max ${choice} working`);

  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1">
      {waiting > 0 ? (
        <span title={`${waiting} waiting for a slot`} aria-hidden>
          <CountBadge count={waiting} tone={STATUS_META.queue.badge} />
        </span>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Working limit: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          openMenu();
        }}
        className={`inline-flex h-5 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 ${TYPE.badge} leading-none ${ACCENT_TEXT.amber} transition-colors hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-7 ${
          open ? "bg-amber-500/15" : ""
        }`}
      >
        <span>{limit === null ? "No limit" : `Max ${limit}`}</span>
        <Icon name="ChevronDown" fallback="ChevronUp" className="size-3" aria-hidden />
      </button>
      {open
        ? createPortal(
            <ul
              ref={menuRef}
              id={menuId}
              role="listbox"
              tabIndex={-1}
              aria-label="Working limit"
              aria-activedescendant={`${menuId}-${active}`}
              data-bb-plugin={PLUGIN_SLUG}
              onKeyDown={onMenuKey}
              className={`fixed z-50 min-w-36 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground outline-none ${ELEVATION.float} [scrollbar-width:thin] ${
                placement ? "" : "invisible"
              }`}
              style={{ ...BOARD_PALETTE, right: placement?.right, top: placement?.top, bottom: placement?.bottom, maxHeight: placement?.maxHeight }}
            >
              {choices.map((choice, index) => {
                const selected = choice === limit;
                return (
                  <li
                    key={choice ?? "none"}
                    id={`${menuId}-${index}`}
                    role="option"
                    aria-selected={selected}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => choose(choice)}
                    className={`flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 ${TYPE.body} transition-colors pointer-coarse:h-9 ${
                      index === active ? "bg-accent text-accent-foreground" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 tabular-nums">{optionText(choice)}</span>
                    {selected ? <Icon name="Check" className={`size-3.5 shrink-0 ${ACCENT_TEXT.amber}`} aria-hidden /> : <span className="size-3.5 shrink-0" aria-hidden />}
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </span>
  );
}
