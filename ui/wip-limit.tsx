import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_BADGE } from "./model";
import { TYPE } from "./primitives";

const LIMIT_CHOICES = [0, 1, 2, 3, 4, 5];

/**
 * The Working column's limit picker: a native select under a chip reading working cards over the limit, and how
 * many threads wait in Queue to start. Amber once the limit is reached.
 */
export function WipLimitControl({ limit, working, waiting, onChange }: {
  limit: number | null;
  /** Working cards holding a slot: not Blocked. */
  working: number;
  waiting: number;
  onChange: (limit: number | null) => void;
}) {
  const full = limit !== null && working >= limit;
  // A limit set elsewhere (the RPC takes 0 to 50) still shows as the selected choice.
  const choices = limit === null || LIMIT_CHOICES.includes(limit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, limit].sort((a, b) => a - b);
  const tone = full ? ACCENT_BADGE.amber : "text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <label
      title="Most threads working at once. Past it, new threads and follow-ups to idle threads wait in Queue until a working thread finishes; at Max 0 they wait until you raise the limit. Blocked threads and child threads of a working one don't count. A waiting card's play button starts it past the limit."
      className={`relative ml-auto inline-flex h-6 shrink-0 cursor-pointer select-none items-center gap-1 rounded-md px-1.5 ${TYPE.badge} leading-none transition-colors focus-within:ring-2 focus-within:ring-ring pointer-coarse:h-8 ${tone}`}
    >
      <span>{limit === null ? "No limit" : `${working}/${limit} working`}</span>
      {waiting > 0 ? <span className="font-medium opacity-80">· {waiting} in queue</span> : null}
      <Icon name="ChevronDown" fallback="ChevronUp" className="size-3" aria-hidden />
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
