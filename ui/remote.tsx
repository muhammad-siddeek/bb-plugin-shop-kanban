import { TaskStatusMark } from "./card";
import type { RemoteApi } from "./hooks";
import { formatMoney, type RemoteItem } from "./model";
import { Age, GroupHeader, listProblems, useBbLinks } from "./primitives";
import { ACCENT_TEXT, CHIP, ONE_LINE_AGE, ONE_LINE_PAD, TYPE, cardFrame, cardTitle } from "./styles";

// The Working column's Remote section: River sessions and Torrent tickets the user is part of that are live, one line
// each, with the board's own working and blocked marks. A row opens the ticket on Torrent or the session's Slack
// thread. Hidden while there is nothing live and nothing failed; sources that can't run here (no gcloud, not a
// Shopify account) stay quiet.

const SOURCE_NAME: Record<RemoteItem["source"], string> = { torrent: "Torrent", river: "River" };

function RemoteRow({ item, now }: { item: RemoteItem; now: number }) {
  const links = useBbLinks();
  return (
    <article className={`group relative ${cardFrame()} ${ONE_LINE_PAD}`}>
      <div className="flex h-5 items-center gap-2">
        <TaskStatusMark status={item.status} unread={false} />
        <button
          type="button"
          onClick={() => links.openUrl(item.url)}
          aria-label={`${item.title}, ${item.detail}, on ${SOURCE_NAME[item.source]}`}
          className="group/open block min-w-0 flex-1 truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className={`flex min-w-0 items-center gap-1.5 ${TYPE.body} leading-5`}>
            <span className={`${CHIP} bg-muted text-muted-foreground`}>{item.key}</span>
            <span className={`min-w-0 truncate ${cardTitle()} text-foreground/85 group-hover/open:underline`}>
              {item.title}
            </span>
          </span>
        </button>
        {item.status === "blocked" ? <span className={`shrink-0 ${TYPE.meta} font-medium ${ACCENT_TEXT.rose}`}>{item.detail}</span> : null}
        {item.cost !== null ? (
          <span className={ONE_LINE_AGE}>{formatMoney(item.cost)}</span>
        ) : (
          <Age at={item.updatedAt} now={now} className={ONE_LINE_AGE} />
        )}
      </div>
    </article>
  );
}

export function RemoteSection({ remote, now }: { remote: RemoteApi; now: number }) {
  const { state } = remote;
  if (!state) return null;
  const problems = listProblems(
    [remote.error, state.error],
    state.sources.map((source) => ({ search: SOURCE_NAME[source.source], error: source.error, missing: source.missing })),
  );
  if (state.items.length === 0 && problems.length === 0) return null;
  return (
    <div role="group" aria-label="Remote" className="space-y-1 pt-1">
      <GroupHeader title="Remote" count={state.items.length} refreshing={state.refreshing} problems={problems} />
      {state.items.map((item) => (
        <RemoteRow key={item.id} item={item} now={now} />
      ))}
    </div>
  );
}
