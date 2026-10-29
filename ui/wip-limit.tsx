import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_BADGE } from "./model";

const LIMIT_CHOICES = [0, 1, 2, 3, 4, 5];

/**
 * The WIP column's limit picker: a native select under a chip reading running cards over the limit, and how many
 * threads wait for a slot. Amber once WIP is full.
 */
export function WipLimitControl({ limit, running, waiting, onChange }: {
  limit: number | null;
  /** WIP cards holding a slot: running, not Blocked. */
  running: number;
  waiting: number;
  onChange: (limit: number | null) => void;
}) {
  const full = limit !== null && running >= limit;
  // A limit set elsewhere (the RPC takes 0 to 50) still shows as the selected choice.
  const choices = limit === null || LIMIT_CHOICES.includes(limit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, limit].sort((a, b) => a - b);
  const tone = full ? ACCENT_BADGE.amber : "text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <label
      title="Most WIP threads running at once. Past it, new threads and follow-ups to idle threads wait in Queue and start as WIP threads finish; Max 0 holds every new start until you raise it. Blocked threads and child threads of a running one don't count. Send now on a waiting message skips the limit."
      className={`relative ml-auto inline-flex h-6 shrink-0 cursor-pointer select-none items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold leading-none tabular-nums transition-colors focus-within:ring-2 focus-within:ring-ring pointer-coarse:h-8 ${tone}`}
    >
      <span>{limit === null ? "No limit" : `${running}/${limit} working`}</span>
      {waiting > 0 ? <span className="font-medium opacity-80">· {waiting} in queue</span> : null}
      <Icon name="ChevronDown" fallback="ChevronUp" className="size-3" aria-hidden />
      <select
        aria-label="WIP limit"
        value={limit ?? ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            Max {choice} running
          </option>
        ))}
        <option value="">No limit</option>
      </select>
    </label>
  );
}
