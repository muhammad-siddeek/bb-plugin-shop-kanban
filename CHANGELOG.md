# Changelog

## Unreleased

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
