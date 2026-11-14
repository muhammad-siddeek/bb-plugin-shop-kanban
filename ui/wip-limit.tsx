import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT } from "./model";
import { TYPE } from "./primitives";

const LIMIT_CHOICES = [0, 1, 2, 3, 4, 5];
/** Past this many slots the dots stop reading at a glance; a count shows instead. */
const MAX_SLOTS = 6;

/**
 * The Working column's limit picker, in the column's amber: one slot per allowed working thread, filled as threads
 * take them, and over-the-limit threads as ringed slots past the end. A native select sits under it for the choice.
 */
export function WipLimitControl({ limit, working, waiting, onChange }: {
  limit: number | null;
  /** Working cards holding a slot: not Blocked. */
  working: number;
  waiting: number;
  onChange: (limit: number | null) => void;
}) {
  // A limit set elsewhere (the RPC takes 0 to 50) still shows as the selected choice.
  const choices = limit === null || LIMIT_CHOICES.includes(limit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, limit].sort((a, b) => a - b);
  const slots = limit !== null && Math.max(limit, working) <= MAX_SLOTS;
  const label = limit === null ? `${working} working, no limit` : `${working} of ${limit} working`;
  return (
    <label
      title="Most threads working at once. Past it, new threads and follow-ups to idle threads wait in Queue until a working thread finishes; at Max 0 they wait until you raise the limit. Blocked threads and child threads of a working one don't count. A waiting card's play button starts it past the limit."
      className={`relative ml-auto inline-flex h-5 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 ${TYPE.badge} leading-none ${ACCENT_TEXT.amber} transition-colors hover:bg-amber-500/10 focus-within:ring-2 focus-within:ring-ring pointer-coarse:h-8`}
    >
      {slots ? (
        <span className="flex items-center gap-[3px]" aria-hidden>
          {Array.from({ length: Math.max(limit, working) }, (_, slot) => (
            <span
              key={slot}
              className={`size-2 rounded-full ${slot < working ? "bg-amber-500" : "border border-amber-500/60"} ${
                slot >= limit ? "ring-1 ring-amber-500/40 ring-offset-1 ring-offset-card" : ""
              }`}
            />
          ))}
        </span>
      ) : null}
      <span className="tabular-nums">
        {limit === null ? "No limit" : slots ? `${working}/${limit}` : `${working}/${limit} working`}
      </span>
      {waiting > 0 ? <span className="font-medium opacity-80">+{waiting} waiting</span> : null}
      <Icon name="ChevronDown" fallback="ChevronUp" className="size-3 opacity-70" aria-hidden />
      <span className="sr-only">{label}</span>
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
