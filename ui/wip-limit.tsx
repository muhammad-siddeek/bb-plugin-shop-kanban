import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT } from "./model";
import { TYPE } from "./primitives";

const LIMIT_CHOICES = [0, 1, 2, 3, 4, 5];
/** Past this many marks a row stops reading at a glance; a count shows instead. */
const MAX_MARKS = 6;

/** A thread working past the limit: the slot dot with a hole punched through it, a pixel smaller. */
function OverLimitMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-[7px] shrink-0 text-amber-500" fill="currentColor" fillRule="evenodd" aria-hidden>
      <path d="M8 0a8 8 0 1 0 0 16A8 8 0 1 0 8 0zm0 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4z" />
    </svg>
  );
}

/**
 * Working threads against the limit, the same in the Working column's header, the title bar and the hidden board's
 * pill: blocked threads as red dots first (when given), then one amber dot per working thread in a slot, a ring per
 * free slot, and a warning mark per thread over the limit, all one row of marks; then `working/limit` and `+N waiting`.
 * With no limit every working thread is a dot. Past MAX_MARKS of either kind the marks give way to counts.
 */
export function WorkingMeter({ limit, working, waiting, blocked = 0 }: {
  limit: number | null;
  /** Working threads holding a slot: not Blocked. */
  working: number;
  waiting: number;
  blocked?: number;
}) {
  const slots = Math.max(limit ?? 0, working);
  const marks = slots <= MAX_MARKS;
  const over = limit !== null && working > limit;
  const count = limit === null ? (marks ? null : `${working} working`) : marks ? `${working}/${limit}` : `${working}/${limit} working`;
  const label = [
    blocked ? `${blocked} blocked` : null,
    limit === null ? `${working} working, no limit` : `${working} of ${limit} working${over ? `, ${working - limit} over the limit` : ""}`,
    waiting ? `${waiting} waiting` : null,
  ].filter(Boolean).join(", ");
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {blocked > 0 || (marks ? slots > 0 : over) ? (
        <span className="flex items-center gap-[3px]" aria-hidden>
          {Array.from({ length: Math.min(blocked, MAX_MARKS) }, (_, index) => (
            <span key={`blocked-${index}`} className="size-2 rounded-full bg-rose-500" />
          ))}
          {blocked > MAX_MARKS ? <span className={`${TYPE.badge} ${ACCENT_TEXT.rose}`}>+{blocked - MAX_MARKS}</span> : null}
          {marks ? (
            Array.from({ length: slots }, (_, slot) =>
              slot >= working ? (
                <span key={slot} className="size-2 rounded-full border border-amber-500/60" />
              ) : limit !== null && slot >= limit ? (
                <OverLimitMark key={slot} />
              ) : (
                <span key={slot} className="size-2 rounded-full bg-amber-500" />
              ),
            )
          ) : over ? (
            <OverLimitMark />
          ) : null}
        </span>
      ) : null}
      {count ? <span className="tabular-nums" aria-hidden>{count}</span> : null}
      {waiting > 0 ? <span className="font-medium opacity-80" aria-hidden>+{waiting} waiting</span> : null}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The Working column's limit picker, in the column's amber: the working meter over a native select for the choice. */
export function WipLimitControl({ limit, working, waiting, onChange }: {
  limit: number | null;
  /** Working cards holding a slot: not Blocked. */
  working: number;
  waiting: number;
  onChange: (limit: number | null) => void;
}) {
  // A limit set elsewhere (the RPC takes 0 to 50) still shows as the selected choice.
  const choices = limit === null || LIMIT_CHOICES.includes(limit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, limit].sort((a, b) => a - b);
  return (
    <label
      className={`relative ml-auto inline-flex h-5 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 ${TYPE.badge} leading-none ${ACCENT_TEXT.amber} transition-colors hover:bg-amber-500/10 focus-within:ring-2 focus-within:ring-ring pointer-coarse:h-8`}
    >
      {limit === null ? (
        <>
          <span>No limit</span>
          <span className="sr-only">{working} working</span>
        </>
      ) : (
        <WorkingMeter limit={limit} working={working} waiting={waiting} />
      )}
      <Icon name="ChevronDown" fallback="ChevronUp" className="size-3 opacity-70" aria-hidden />
      <select
        aria-label="Working limit"
        value={limit ?? ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            Max {choice} working
          </option>
        ))}
        <option value="">No limit</option>
      </select>
    </label>
  );
}
