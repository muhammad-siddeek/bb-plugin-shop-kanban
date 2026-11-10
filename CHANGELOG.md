# Changelog

## Unreleased

- Resource chips warn sooner: memory turns amber at 70% and red at 80% (was 80
  and 90), disk at 80% and 90% (was 90 and 96).
- The Shopify AI chip turns amber from $300 a day and red from $500 (was amber
  from $450, never red).
- The AI spend popover shows today's spend and the last 7 days' total, a bar
  chart of those 7 days with dashed lines at the $300 daily budget and the $500
  red mark (hover a bar for its day and amount), and the daily average and last
  hour's spend. The per-model list and token counts are gone, from the
  popover and the RPC payload. Past days come from
  the data warehouse's hourly rollup of proxy spend (via `bq`, signed in as
  your gcloud account), cut at local midnight; today comes from the proxy. The
  server also records each day's last proxy reading, read every 5 minutes in
  the background, and a day shows whichever is higher, so yesterday is whole
  before the warehouse catches up. Without daily figures the popover says why
  (or that they are still loading), and the board reads again the moment they
  land rather than at the next minute's poll.
- The proxy's "seven days" total is today plus the 7 days before it, 8 days in
  all. Where it stands in for the 7-day total, it is labelled "Today + 7 days".

## 0.16.2

- The Shopify AI spend chip only ever sends Shopify credentials. A key from the
  environment is used only when it is a Shopify proxy key, and a key is minted
  only when gcloud's active account is on shopify.com. Before, any gcloud
  account's identity token, or another proxy's `PI_PROXY_API_KEY`, could be sent
  to the Shopify proxy. Without Shopify credentials the chip stays hidden and
  the board checks again hourly instead of every 30 seconds.
- The marketplace overview mentions the resource chips and Mark as unread.

## 0.16.1

- One type scale across the board, its popovers and the title bar: titles 13px,
  body text 12px, secondary text 11px, section labels and badges 10px, chips
  9px. Eleven sizes (9 to 13px in half-pixel steps, plus 12px written two ways)
  become five. Review, pull request, issue and search result titles are
  semibold like card titles (bold while unread), times and costs grow from
  10.5px to 11px, and headings share one letter spacing.
- Text lines up across the board. Column titles, the Queue tabs, section
  headings (Parked, Reviews, Open…), the new-thread form and the title bar's
  icon start on the cards' content edge, where the status marks sit. The
  working-limit picker is a pill like the counts beside it, and it, the hide
  button and the review and pull request actions end on the cards' right edge,
  past the scrollbar gutter that every column now keeps. A heading and its
  count are 6px apart everywhere, and the AI and CPU popovers space and weight
  their rows the same.

## 0.16.0

- Done cards swap the pause button, which did nothing there, for a "Mark as unread"
  button. It shows on read cards and puts them back at the top of Done as unread.
- The resource monitor shows today's Shopify AI proxy spend next to the machine
  gauges, read from the proxy's own per-user counter (every tool on the proxy,
  not just bb threads) and refreshed once a minute. The chip turns amber from
  $450. Its panel section lists the costliest models, token counts, this hour
  and the last 7 days.
- Each resource chip now opens its own popover (on hover, or click to pin it)
  showing only that resource, instead of one long panel covering everything.
  The chips sit directly in the title bar with no surrounding button border.
- Card titles now follow what a thread opened with when that was an attached
  file, such as a pasted brief: the labeler reads the opening of text
  attachments and names attached images. Before, a thread started from a
  pasted file got a title guessed from the other cards on the board. A title
  written before the board could read the opening message is written afresh
  once. When the user's messages are too short to name the thread ("keep
  going"), the labeler also reads the agent's last finished reply. A thread
  with no subject ("reply with ok") is filed under `general` instead of
  borrowing another card's category.
- Simpler code throughout, about 230 lines shorter, with no change in behavior.

## 0.15.1

- The open board no longer covers the bottom of bb's left sidebar (settings and
  the other footer controls). The panel now starts at the sidebar's right edge
  and follows it as it collapses, switches to the rail or is resized; with the
  sidebar hidden, as on phones, it still spans the full width.

## 0.15.0

- The title bar shows how close the bb machine is to running out of CPU,
  memory, disk or battery, also when you open bb from another device. Each
  gauge is a half-transparent capsule in the metric's color with a solid icon
  and a percentage cut out of it, where high always means danger: CPU busy
  (blue chip), memory pressure (red memory stick; not "used", which macOS
  keeps full), disk full (yellow hard drive), and battery drain (green
  battery, AC when plugged in). A capsule turns amber, then rose, as it nears
  running out. Click for a Headroom / Busy / Strained verdict, advice, exact
  figures, swap activity and the heaviest apps. New RPCs: `system_stats`,
  `system_processes`.

- The Hide board button is a solid circle (white in dark mode) so it stands out.

## 0.14.1

- One word for a thread with a turn in progress: Working. The WIP column is
  now Working and its limit the working limit. The chip reads
  `3/5 working · 2 in queue`, the choices `Max N working`; a card it holds
  reads "Waiting to start" (was "Waiting for a WIP slot"), and bb's queue row
  says "Working limit reached" or "Working limit is 0". Card status marks and
  reasons read Working, `N child threads working` and In queue (were In
  progress, `N child threads running` and Queued), and parking a working
  thread from the CLI says it is working. Column ids (`wip` in `board_list`,
  `bb shop-kanban list`) and `board_set_wip_limit` are unchanged.
- The Working mark is an amber petal spinner (was a spinning arc), so it
  doesn't look like the context meter under it.
- Queue gets three tabs, kept across reloads: **Queue** (its threads),
  **In** (the review queue, then issues assigned to you) and **Out** (your
  open pull requests, drafts included, and ones merged in the last 30 days).
  A merged pull request stays in Out until you mark it Measured and Demoed,
  or archive it. Each item's title drafts a thread that takes it further:
  land it, measure and demo it, or work the issue. New settings:
  `outgoingSearches`, `shippedSearches`, `shippedDays`, `assignedSearches`.
  Reviews are no longer a collapsible section above Queue's cards, and the
  header `+` is gone (the New thread button stays).
- Parked is a section under the Queue tab, below the queued threads (was a
  column under Done). Drag a finished thread onto it to come back to it later.
- The In tab's count covers only pull requests requested of you by name, not
  your teams'.
- Cards stack the status mark, the harness icon (grey) and a context pie
  (was a ring with a percentage; dim grey until amber at 70%) down their
  left edge, at the same card height. The footer has the cost and status on
  the left and the time on the right (was the other way round). The
  percentage is in the tooltip.
- A card's `[tag]` pill takes up to 80% of the title line (was 45%), so it
  rarely cuts off.
- A thread that errored and then got a follow-up shows in Queue while the
  follow-up waits to send, instead of Blocked ("Errored") in Working.

## 0.14.0

- Agents stop reporting to the board. Columns have followed live thread
  state since 0.2.0, yet every thread's agent was still told to move its
  card and mark a result, and threads started from the board carried the
  same instructions at the end of their first message. The plugin now gives
  agents no standing instructions, threads start with your message alone,
  and the bundled skill says to use the board only when you ask.
- Removed: the `shop_kanban_move_card` and `shop_kanban_mark_result` agent
  tools, `bb shop-kanban move|success|fail`, and the `column` input of
  `shop_kanban_spawn_task` and `board_spawn_task`. A reported failure no
  longer turns an idle card Blocked, and a reported Done or Blocked no
  longer marks the thread unread or turns on its notifications. Agent notes
  no longer stand in for a card's summary; stored ones are dropped.
- `shop_kanban_spawn_task` and `shop_kanban_create_theory_tasks` stay, for
  when you ask an agent to spawn threads. Theory threads end by saying
  whether the theory worked, and the investigation thread is left as it is.

## 0.13.1

- Review requests show up soon after waking the machine. The 5-minute review
  poll ran on a timer that stops while the machine sleeps, so after a long
  sleep the queue stayed stale for up to 5 more minutes, and opening the
  board did not search again. The poll now goes by the wall clock and checks
  every 30 seconds, a board read searches again once the last search is a
  minute old, and a failed search (offline, no host, a CLI timeout) is
  retried after a minute instead of 5.

## 0.13.0

- The Queue column's New thread button always shows, not only while Queue is
  empty.
- The WIP limit picker offers Max 0 to Max 5 running, then No limit. Max 0
  holds every new start until you raise it; running threads keep going.
  `board_set_wip_limit` takes 0 to 50.
- The WIP limit chip reads `3/1 working · 5 in queue` (was `3/1 running · 5
  waiting`).

## 0.12.0

- Start a waiting card now: a Queue card whose message waits to send (held
  for a WIP slot, or otherwise queued) shows a play button in place of the
  pause button, on hover and always on touch. Dragging it onto WIP, which
  outlines and shows "Drop to start now" while you drag one, does the same.
  Its message goes out with bb's Send now, past the WIP limit, and the card
  moves to WIP. New `board_start_task` RPC; `board_list` tasks carry
  `startable`.
- The Queue + form no longer fails to start a thread when no thread is open
  in bb; the thread starts in the default project.
- Notes and result summaries are capped at 2,000 characters and short names
  at 40: `bb shop-kanban add|move|success|fail` refuse longer ones, as the
  agent tools already did, and a longer stored note (such as a failed
  thread's error) is cut. One oversized note could fill the 256 KB row all
  cards share and fail every later board write.

## 0.11.0

- WIP limit: a picker at the top of WIP caps how many threads run at once,
  to pace spend. It shows running over the limit (amber when full) and how
  many threads wait. Past the limit, a message that would start another
  thread waits in that thread's message queue (the card stays in Queue,
  marked "Waiting for a WIP slot") and bb sends it when a WIP thread
  finishes. Blocked threads don't count; steers, follow-ups and child threads
  of a running thread go through, and running threads are never stopped.
  Send now skips the limit. New `board_set_wip_limit` RPC; `board_list`
  carries `wipLimit: { limit, waiting }`.
- New grey Parked column after Done for idle threads you want to come back
  to later, such as a finished thread whose suggested next steps can wait.
  Drag an idle card onto Parked, the only column that takes a drop (it
  outlines while you drag and fills in under the pointer, with a "Drop to
  park" slot), or hover the card and press the pause button. The return
  button unparks it; `bb shop-kanban park|unpark <thread-id>` does the same.
  Running and parked cards can't be dragged. A parked card keeps its status
  (Completed, Asked a question, ...) and leaves Parked on its own when the
  thread runs again.
- The Blocked column is gone: blocked threads sit at the top of WIP and keep
  their red card, stripe and title-bar count. Agents and the CLI still
  report `blocked`.
- `bb shop-kanban list --json` and `board_list`: each task's `column` is
  `queue`, `wip`, `done` or `parked`, and a new `status` field carries the
  card's state (`queue`, `wip`, `blocked`, `done` or `parked`). Blocked
  threads report `column: "wip"`, `status: "blocked"`.
- Model-written card titles are more representative:
  - Tags and titles keep the model's whole phrase instead of being cut to
    2 and 6 words (`[rank and]` is now `[rank and commit]`).
  - The labeler sees the other cards' titles, so related threads share a
    tag; archived threads no longer steer the choice.
  - A message that mentions `@thread:<id>` ("Continue from @thread:…") is
    labeled with that thread's title alongside it.
  - Harness notices sent as user turns (`<irc>…`, `<system-notice>…`) are
    left out of the labeler's input and refresh only the summary, so
    background agents no longer crowd out your messages or retitle the card.
  - A title is checked against all your messages: it changes when the goal
    changes (say, from explaining a problem to fixing it), not for steps such
    as commit or release.
  - Every card is relabeled once after updating.
- On phones, swiping sideways anywhere on the board moves between columns,
  including over a column's cards; before, only the column headers took the
  swipe. In Safari the harness icon no longer draws 300px wide, which made
  cards overflow their column so a swipe could scroll the cards out of view.

## 0.10.1

- The card tooltip shows only the harness session: harness, model and
  thinking level, then tokens and context share, then cost, each on its own
  line, then access mode, service tier and model id. It no longer repeats
  the summary or the update time and status, and threads with no session yet
  have no tooltip.
- Light mode is easier to read: column titles, counts, risk chips, the card
  footer and empty states use one shade darker on light backgrounds, and
  dark mode is unchanged. Long titles cut at the last whole word instead of
  mid-word.

## 0.10.0

- The title bar's refresh button is gone; the board already updates live,
  and the review searches still re-run every 5 minutes and when their
  settings change. The hide button is wider, and larger still on touch.
- Phones (below 640px): each column fills the screen with the next one
  peeking in, and swipes snap column by column. The title bar gives its room
  to search, and search results span the bar instead of running off screen.
  The hidden board is a full-width bottom bar in its own strip; the floating
  pill used to cover bb's agent options and permission mode buttons.
- Touch screens: larger hide, new-thread, archive, review action and Me |
  Team buttons; 16px text in the search, new-thread and request-changes
  fields so iOS doesn't zoom in.
- One tooltip per card instead of one per footer item: resting the pointer
  anywhere on a card (or tabbing to it) opens it beside the card, never over
  it, and scrolling the board closes it. It adds the full summary when the
  card cut it off, and the footer's time and status. Native hover titles on
  cards are gone.
- Hovering a card gives its summary the footer's line, so three lines show.
  Summaries are written longer to use it (about 24 words, up from 18), and
  existing cards are re-summarized once; titles are kept.
- The new-thread form and the empty Queue's New thread button sit above
  Reviews. What you type is saved as you type and comes back after a reload
  or crash; starting the thread or cancelling clears it.
- The board keeps clear of the iPhone home indicator.
- The omp mark is drawn in omp's pink (`#f84fcc`) instead of the
  surrounding text color, on cards and in bb's sidebar and pickers.

## 0.9.0

- A Reviews section at the top of the Queue column lists open pull requests
  waiting on your review. A Me | Team toggle in its header switches between
  requests of you by name and of your teams, and it opens on Me every time.
  Two new settings, `reviewSearchesMe` and `reviewSearchesTeam`, take one
  `delta:` or `github:` search per line in GitHub search syntax. They are
  read through the `dt` and `gh` CLIs on the persistent host that runs thread
  search. The defaults cover Delta and GitHub, without drafts or your own pull
  requests. A pull request both sides find is listed under Me. Emptying a
  setting hides its side; emptying both hides the section.
- Each card is two lines. The title, behind a low/medium/high risk chip,
  opens bb's new-thread screen with an unsent prompt asking what changed, why,
  and how risky it is. The second line opens the pull request on Delta or
  GitHub, approves it (click twice) or requests changes with a reason; the
  card leaves the queue once the review is submitted. Archive hides a card
  for good.
- The labeler model writes each pull request a first read, risk plus at most
  three sentences (what, why, what could break), once per head commit. It
  shows as the chip, in the title's tooltip and in the drafted prompt.
- Cards stay marked new until opened from the board, and turn new again when
  commits land. A pull request you reviewed anywhere stays hidden until
  commits land after your review, then returns marked `re-review`, with a
  draft that asks what changed since the commit you reviewed.
- The board's refresh button re-reads the review searches too.
- Machines without the review tools stay quiet. When no persistent host is
  connected, or `dt` or `gh` is not installed or not signed in there, those
  searches are skipped without a warning; hover the Reviews header for the
  reason (for example ``run `gh auth login` ``). With nothing to list, the
  section stays hidden. Other failures still show behind the amber icon.
- Missing tools say how to fix them, once. A missing labeler CLI is logged
  once an hour with the `labelerCommand` hint, and labels retry right after
  a settings change; a missing qmd shows how to install it or set
  `searchCommand` under the search bar. Host commands get `HOME` even when
  the bb daemon started without one, so `gh`, `dt` and `qmd` find their
  config.
- A host command that hangs (ignores its stop signal, or leaves a background
  process holding its output) is killed a second after its timeout, so it
  can't hold up labels, search, reviews or costs. Threads on a disconnected
  host count the cost bb reports instead of waiting on the host.
- Archiving a thread drops its board state and label from plugin storage, so
  storage stays bounded by the threads you keep. Corrupt stored state is
  dropped and rebuilt instead of breaking the board.
- The board and the review queue stop polling while bb's window is hidden
  and read again when it comes back. One board read and one search request
  are in flight at a time.
- The cost tooltip wraps instead of cutting off a long line such as
  `$185.13 spent across 47 threads (… estimated)`.
- `bb shop-kanban remove` exits 1 when nothing was archived. The
  `bb shop-kanban children` command, a no-op since child threads always roll
  up into their parent, is gone; agent tools ignore the old `showOnBoard`
  and `showChildren` inputs.

## 0.8.0

- A card's cost now covers the thread's whole tree: the thread, every
  descendant thread (hidden and archived ones included) and their harness
  subagents. It used to be the card thread's own figure only. The tooltip
  says how many threads the cost spans.
- omp and Pi threads are read from their transcripts on the thread's host.
  For omp, subagents at every depth count; omp's own figure covers only a
  session's replies and its direct tasks, and reaches bb only at the end of
  a turn. Pi reports no cost to bb at all, so Pi threads used to add nothing.
  When no transcript is found there, the board falls back to what the harness
  reported.
- A forked transcript doesn't count the entries it copied from its source
  (those count once, in the source), unless the source is gone.
- Replies saved with tokens but no price are estimated, and the card shows
  `~` in front of the cost; the tooltip says how much is estimated. Since
  omp 18.13 every Shopify Auto (`shopify/auto`) reply is saved at $0: omp
  ignores the price its router-cost plugin works out, and the model that
  served the turn isn't saved. Such replies are priced at the average rate,
  per token bucket, that the same provider and model charged across the
  host's other transcripts, i.e. the mix of models the router served before.
- The cost appears one board refresh after the board opens instead of
  holding up the first load.

## 0.7.1

- Search finds running threads. They were left out of the index until they
  settled, so a thread that kept running (or never settled) could not be found.
  Running threads are now exported at most every 5 minutes, then once more when
  they settle.

## 0.7.0

- A search bar in the board's title bar finds past threads, archived
  ones included, through a qmd full-text index of every thread's user turns
  and assistant replies. Picking a result only opens the thread in bb; the
  board is left as it is. New `searchCommand` setting (default `qmd`; empty
  turns search off). The index lives on one connected persistent host, rebuilds
  itself when its files or qmd's index go missing, and runs qmd through
  cross-spawn so Windows npm shims work.
- User-facing text and agent instructions (board, agent tools, bundled skill,
  CLI output, docs) now say "thread", bb's own word, instead of task, card or
  conversation. Tool names, RPC methods and CLI commands are unchanged.

## 0.6.0

- Cards show, flush right in the footer: what the session has spent (when the
  harness reports cost), a ring with the share of the context window in use
  (amber at 70%, red at 90%), and the icon of the harness the thread runs on
  (e.g. omp, Pi, Codex; the same artwork as the bb sidebar).
- Hovering or focusing the cost, the ring or the icon opens a compact
  three-line tooltip: harness, model and thinking level; tokens used, context
  share and cost; then access mode, service tier and the raw model id. A thin
  bar along its bottom edge shows how full the context window is.
- The archive button moved to the card's top-right corner and appears on
  hover or focus (always shown on touch devices). The footer keeps the
  updated time and status on the left.
- omp threads show bb's omp mark instead of a generic toolbox, on cards and
  in bb's sidebar and pickers, when a `customAgents` entry replaces bb's
  shipped omp agent. The mark follows the surrounding text color.
- Published: MIT license, public repository at
  github.com/muhammad-siddeek/bb-plugin-shop-kanban, and a store overview
  (`PLUGIN_OVERVIEW.md`).

## 0.5.0

- The card for the thread open in bb is highlighted: it renders in the
  opposite theme (light card in dark mode, dark card in light mode) with an
  outline in its column's accent color.
- The selected card stays fully visible: the board scrolls just enough to show
  it when it becomes selected (from bb or the board), when it's clicked while
  partly hidden, and when the layout shifts under it (reorders, size changes,
  panel resize). Scrolling away yourself never snaps back.

## 0.4.0

- Public-release prep.
- Configurable labeler: `labelerCommand` (default `pi`, empty turns model
  labels off) and `labelerModels` (default `anthropic/claude-haiku-4-5`).
- Generic example categories and titles.
- Typed server code, checked against the real plugin SDK types.
- Server split into `server/` modules and UI into `ui/` modules.
- Design polish for cards, columns, overlay chrome, and the reopen pill.

## 0.3.0

- Read status on Done cards: unread cards come first with a solid check, read
  cards below with a tinted check.
- bb sidebar thread titles sync with card titles and follow the overall user
  intent; manual renames are respected.
- Oldest-first order within columns.

## 0.2.0

- Columns derived from live thread state; every non-archived top-level thread
  is a card.
- Model-written `[category] intent` titles and summaries.
- Cards open threads at the latest message and have an archive button.
- Bottom overlay redesign: checklist icon, color-coded uppercase columns,
  relative timestamps, reopen pill with blocked/done counts.
