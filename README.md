# Shop Kanban

A Kanban board for [bb](https://getbb.app) threads. It opens as a drawer along
the bottom of the bb app and shows every non-archived top-level thread. Child
threads roll up into their parent thread.

The drawer starts beside bb's sidebar. The board's title bar (domain tabs,
search, machine resources) runs along its top, next to bb's page, which ends
at the drawer's upper edge; drag that edge, or focus it and use the arrow
keys, Page Up/Down, Home and End, to resize. The chevron at the right end of
the title bar hides the columns: only the title bar stays, with every control
still there, across the full width of the window's bottom edge, and the
chevron shows the columns again. The title bar's dropdowns open down over the
columns, or up over bb's page while the board is hidden.

## Domains

The title bar starts with two tabs, each a separate board: **Shopify** (the
Shopify bag) and **Other** (a gamepad). Each tab shows its own count badges
while any of its threads work or wait on you, and clicking one shows the
board if it was hidden. Shopify has every column and section below; Other has
only its threads in Queue (Parked included), Working and Done, with no Radar,
Out, Outgoing PRs or Remote. The working limit spans both: its picker counts
every domain's working threads.

A thread joins a domain when it is created and never moves: one started from
the board's New thread form joins the open tab, a child thread its parent's
domain, and any other new thread (bb's New thread page, the CLI) the tab open
at the time; Radar submissions always join Shopify. The open tab is kept on the
plugin server across reloads. The domain is stored in the thread's plugin
metadata (`domain`), so it survives archiving and restoring. Threads from
before domains were sorted once: those Done listed under Other moved to Other,
the rest stayed on Shopify.

## Columns

Columns are derived from live thread state; the only drags are parking a
thread (see Parked) and starting a waiting one (see Working limit).

- **Queue**: the thread has not started yet (pending, queued, or no output).
  A thread that errored and then got a follow-up stays here while the
  follow-up waits to send, not Blocked in Working. Queue's header has three
  tabs, kept across reloads: **Queue** (these threads), **Radar** (discovered
  opportunities and techniques), and **Out** (your recently merged pull
  requests). Out disappears when its settings are empty.
  Your open pull requests sit under Queue's threads as **Outgoing PRs**,
  above Parked (see Work lists).
- **Working**: the thread or one of its descendants has a turn in progress,
  background work included. Blocked threads sit at the top of Working as red cards: the
  thread is idle and needs you (a pending interaction, an error, or a last
  reply that asks a question). Each domain tab in the title bar counts its
  working threads in amber and blocked threads in red, each gone at zero. The
  Working limit and the waiting count show only in Working's header.
- **Remote** (a section at the bottom of Working): Shopify River sessions and
  Torrent tickets you're part of that are live, one line each. River sessions
  are those you have spoken in this week (yours or someone else's thread) with
  a turn in progress or blocked; Torrent tickets are the ones in your Your work
  that an agent is working or that wait on you (Human Review, Blocked on
  Human), with what their agents spent. Red marks the ones waiting on you; a
  row opens the ticket on Torrent or the session's Slack thread. They are read
  on the connected persistent host with `gcloud auth print-identity-token`,
  about a minute behind; without gcloud or a Shopify account the section stays
  hidden. Remote work doesn't count toward the working limit.
- **Done**: the thread is idle and its last reply reports completion. Cards
  are one line (status, tag, title, and what the thread's tree has spent, or
  its age while it has no cost). Read cards come first with no header, then
  an **Unread** section (unread cards also wear a solid check), each newest
  finish first. Reading a card moves it up into the read cards; marking it
  unread moves it back. The age is when the thread finished. Read state and
  finish time are bb's own (the sidebar's unread dot). The column's count is
  every Done card, read and unread; the Unread section counts its own.
- **Parked** (grey): a section under the Queue tab, below the queued threads, one line per card. Idle threads you parked to come back to later, such as a
  finished thread whose suggested next steps can wait. Drag an idle card onto
  Parked (it outlines and shows "Drop to park" while you drag), or hover the
  card and press the pause button; a card waiting to start has a play button
  there instead, so drag it. The return button on a parked card unparks it.
  Parked cards keep their status (Completed, Asked a question, ...) and leave
  Parked on their own when the thread starts working again.

## Radar

Radar's red badge counts unresolved recommendations, not opened drafts. Every
Radar card is one line: its bolt or bulb, the title and its age. Hover an
opportunity's title for its best solution; clicking it brings up bb's full
new-thread composer with the findings, evidence and instruction to implement
that solution. Cancel leaves it unread. Submit creates the thread using the
selected project, environment and model, moves the opportunity to Read, and
opens Queue; a read opportunity's title then opens its thread. The normal
working limit still controls when its thread starts. Dismiss (on hover, right
end, like archive on other cards) removes a recommendation. Techniques open
their originating Slack message, leaving Radar immediately.
Read opportunities follow under a **Read** header, 8 at a time with a "Show
more" button. Scan failures show as an amber mark on the Recommendations
header; hover it for the error.

Refresh scans the sources again and appends unseen opportunity/technique keys.
Existing cards keep their content, read state and thread link; dismissed/opened
techniques never return for the same key. After discovery, three ranker/reviewer
rounds compare the complete visible inbox by demonstrated impact and availability
to own the work. The final reviewed order is persisted across reloads and used for
both opportunities and techniques. Ranking never drops recommendations.
Opening Radar reads the saved snapshot without invoking ranking.

All scans use one watch list: 13 Slack channels, four repositories' PR
titles/descriptions, and ExP/Optimization Vault projects and issues. Discovery
resumes durable per-source checkpoints without a rolling lookback or catch-up
cap. Sources without incremental APIs are compared against saved snapshots.
Imported stores without checkpoints resume where the old engine last ran; a
Slack channel without a thread index builds it from its checkpoint, and a
leader without a contribution checkpoint starts 30 days back. Every read pages
across gateway programs under code mode's 1 MB output limit.

The complete discovery engine lives in this plugin (`host/radar`): Slack/Vault/
GitHub discovery, leadership context, scoring, opportunity watch, resiliency
backlog, feedback and backfill. There is no Slack delivery. It uses the
selected persistent host's signed-in `dev` CLI; `RADAR_DEV_BIN` can select its
absolute path. Tokens remain in the host process and are never stored in the inbox.
Engine configuration lives in `host/radar/config.ts`.

`radarHostId` pins the data owner. `radarEnabled` enables hourly refreshes from
07:00 through 15:00 inclusive, Monday–Friday, America/Toronto (disabled until
configured). A five-minute tick catches up within the current work hour after
sleep and tracks DST; missed hours are not replayed, but source checkpoints
preserve unread history. Completed hours survive reloads. Engine caches and snapshots live under the plugin's
persistent host data directory, inbox resolution state in its server database.
Neither requires the old Radar checkout after importing its data:

```sh
bb shop-kanban radar import /absolute/path/to/old/data
bb shop-kanban radar list --json
bb shop-kanban radar scan # discover new recommendations without Slack delivery
bb shop-kanban radar refresh
bb shop-kanban radar backfill --days 90
bb shop-kanban radar feedback --id <message-id> --vote up [--note "reason"]
```

Import copies missing files without overwriting plugin-owned state. Retire
automations pointing at the old checkout before enabling the plugin schedule.

## Working limit

The picker at the top of Working caps how many threads work at once, to keep
a steady spend rate: Max 0 to Max 5 working, or No limit. The column header's
amber badge counts the threads working, and a blue badge beside the picker
counts messages waiting for a slot; the default is no limit, and the choice
is kept across reloads.

- A thread holds a slot while it or a descendant has a turn in progress and
  it doesn't wait on you, so Blocked threads don't count.
- With the limit reached, a message that would start another thread (a new
  thread, a follow-up to an idle one, a retry) waits in that thread's message
  queue, and the card stays in Queue marked "Waiting to start". bb sends it
  when a working thread finishes, and its queue row says "Working limit
  reached".
- Work inside a working thread goes through: steers, follow-ups and child
  threads it spawns. Working threads are never stopped, so lowering the limit
  only holds new starts.
- Max 0 holds every new start until you raise the limit; threads already
  working keep going.
- Send now on a waiting message skips the limit; Cancel drops it. On the
  board, a waiting card's play button (on hover; always shown on touch) does
  the same, as does dragging the card onto Working, which outlines and shows
  "Drop to start now" while you drag one. It works for any Queue card whose
  message waits to send, not only ones held by the limit.
- `board_start_task` starts a card over RPC; `board_list` marks the cards it
  can start with `startable`.
- `board_set_wip_limit` sets it over RPC (`null` for none, 0 to 50).

## Threads on the board

- A `[category] intent` title, e.g. `[docs site] search page`. The category
  is the card's badge; the labeler is asked to keep it to 11 characters. The
  title is written back to the bb sidebar thread title unless you rename the
  thread yourself.
- Queue and Working cards are two rows. The first has the status mark (an
  amber petal spinner while working), the tag and title on one line, and what
  the thread's whole tree has spent; the second has a pie with how full its
  context window is (dim grey, amber at 70%, red at 90%), a one-line summary
  of the latest exchange, and how long ago it was updated (`5m`, `3h`, `2d`);
  Working cards skip the age, so their summary runs to the end of the line.
  Costs are whole dollars, rounded up (`$1`, `$54`). Working
  threads refresh these every 5 seconds, idle threads every minute.
- Cards have no colored edge; the status mark carries the state, and the
  content starts 6px in from the card's left border (8px on the right).
- Anything unread is a solid circle with a contrasting mark: a Done thread's
  check, a Radar recommendation's bolt or bulb. Unread counts (the Done
  column, the Radar tab and Recommendations) are solid pills with contrasting
  numbers.
- The board draws with a closed set of colors: four hues, each with one
  meaning (sky queued or new, amber working or warning, red blocked, errors
  or removing, green done or approving), and bb's theme greys for the rest.
  Each hue and grey use one alpha step per job: a 15% tint for fills and
  washes, 50% for lines, 70% for lines that carry a state (the free working
  slot, edges under the pointer), solid for marks and unread pills.
  Errors are red text in the board's readable shade in both themes.
- The four hues are bb's own colors (warning orange, destructive red, success
  green) plus a blue at the same weight for queued, so they follow bb's theme.
  Solid marks carry white on light and bb's canvas color on dark.
- Cards open no popup on hover or focus. A tap on a touch screen opens the
  thread.
- The cost adds up the thread, every descendant thread (hidden and archived
  ones included) and their harness subagents. omp and Pi threads are read from their transcripts on
  the thread's host (omp's sessions dir, `~/.omp/agent/sessions` unless
  `PI_CODING_AGENT_DIR` or `XDG_DATA_HOME` moves it, and bb's Pi bridge
  sessions in `~/.bb/pi-bridge-sessions` unless `BB_PI_BRIDGE_SESSION_DIR`
  moves them). For omp, subagents at every depth (nested
  tasks, background tasks, eval agents, advisors) count; omp itself reports
  only a session's own replies and its direct tasks, and Pi reports nothing.
  Other harnesses count what they report to bb, and so do threads on a
  disconnected host. A fork doesn't count the entries it copied from its
  source while the source's transcript is still there.
- A `~` in front of the cost means part of it is estimated. Replies a harness saved with tokens but no price are priced at
  the average rate, per token bucket, that the same provider and model
  charged across the host's other transcripts. Since omp 18.13 every Shopify
  Auto (`shopify/auto`) reply is saved at $0 without the model that served
  it, so its estimate follows the mix of models the router served before. A
  provider and model never priced on the host stays at $0.
- An archive button in the top-right corner, shown on hover or focus, and
  always on touch screens.
- Clicking a thread opens it at its latest message. The New thread button at
  the top of the Queue tab, shown whether or not Queue has threads, starts a
  new thread with bb's own new-thread composer: provider, model and reasoning,
  project, environment, branch and permission mode, mentions and attachments.
  It opens on No project with omp on omp's default model, whatever bb's New
  thread page last used; any of them can be changed. It takes the button's
  place and keeps its draft across closes, reloads and crashes; the × in its
  corner or Esc closes it.

### On a phone

Below 640px wide, each column takes the width of the screen with the next
one peeking in, and a swipe snaps to the next column. The title bar gives its
room to search, whose results span the bar. While bb's sidebar drawer is open
the board steps aside, and comes back when it closes. While the on-screen
keyboard is up for a field outside the board, such as the thread composer,
the keyboard covers the board instead of pushing bb's page up, so the
composer stays right above it; typing in the board's own search lifts the
board onto the keyboard. On touch screens, buttons and toggles are larger
and text fields use 16px text, so iOS doesn't zoom into them.

### omp icon

An ACP providers `customAgents` entry with id `omp` replaces bb's shipped omp
agent, and bb gives custom agents a generic toolbox glyph. The plugin
registers bb's omp mark for the `acp-omp` provider, drawn in omp's pink
(`#f84fcc`). The registration is app-wide, so bb's sidebar and pickers show
the mark too, but only while this plugin is loaded.

## Model-written labels

Titles, summaries, and the Blocked-vs-Done call for finished replies are
written by a small model. The plugin runs a pi-compatible CLI
(`-p --model --system-prompt`) on the thread's host. Labels are cached and
refreshed only when a thread gets a new user message or a new final reply.

The model sees your messages in the thread, the agent's latest reply, the
thread's current title, the titles of the other cards on the board (so
related threads share a tag), and the title of any thread a message mentions
as `@thread:<id>`. Harness notices that arrive as user turns (messages that
start with a tag such as `<irc>` or `<system-notice>`) are left out: they
refresh the summary but never retitle the card. A title stays while it still
names the thread's goal; steps on the same work, such as commit or release,
don't replace it.

| Setting          | Default                      | Meaning                                         |
| ---------------- | ---------------------------- | ----------------------------------------------- |
| `labelerCommand` | `pi`                         | CLI to run. Leave empty to turn model labels off. |
| `labelerModels`  | `anthropic/claude-haiku-4-5` | Comma-separated models to try in order.         |

```sh
bb plugin config shop-kanban set labelerCommand pi
bb plugin config shop-kanban set labelerModels anthropic/claude-haiku-4-5
```

With labels off, or when the CLI is unavailable, threads use heuristic titles
and an excerpt of the latest message. A missing CLI is logged once an hour
with this hint, and labels are retried right after either setting changes.

## Machine resources

The right end of the title bar shows how close the machine bb runs on (the
one your threads use, even when you open bb from another device) is to running
out of CPU, memory, disk or battery. Each gauge is a grey chip with a solid
icon and a percentage: chip CPU, memory stick memory, hard drive disk, battery.
Every gauge reads as danger: a high number always means trouble, and the chip
turns amber, then red, as it nears running out. The panel it opens sums it up
as Headroom, Busy or Strained.

- **CPU**: share of all cores busy, averaged over 10 seconds. Amber at 80%, red at 95%.
- **Memory**: memory pressure, 100 minus what macOS counts as available to apps
  (not "used", which macOS keeps full on purpose). Amber at 80%, red at 90%.
  macOS's own pressure warning, or swapping above 10 MB/s, lifts it into amber
  or red whatever the percentage.
- **Disk**: how full the home volume is. Amber at 90% or under 25 GB free,
  red at 96% or under 10 GB free.
- **Battery**: how much charge is drained while unplugged. Amber at 80%
  drained (20% left), red at 90%. Plugged in it reads AC beside a charging
  battery: there is nothing to run out of.

Click it for advice on what to stop or clear, each gauge's exact figures (GB
available, swap activity, GB free, time left), and the heaviest apps by CPU or
memory, helper processes counted with their app, each with a grey bar.

The plugin server samples every 2 seconds while a board's title bar is on
screen, open or hidden, and stops 30 seconds after the last one goes away.

## Thread search

The search bar in the board's title bar finds past threads, archived
ones included, by what was said in them. Results show the thread title, a
matching excerpt, an Archived badge and when the thread last changed.
Picking a result (click, or arrow keys and Enter) opens the thread in bb and
nothing else: the board is not touched, nothing is unarchived or marked read.

Search runs [qmd](https://github.com/tobi/qmd) on one connected persistent
host: the one already holding the index while it stays connected, otherwise
the first persistent host bb lists. Ephemeral hosts are skipped, because the
index would go away with them. Every visible thread is exported as one
markdown file (title, then each user turn and assistant reply) under the
plugin's host data directory and indexed by qmd's BM25 full-text search in a
dedicated `shop-kanban` index, collection `threads`. The index syncs about 15
seconds after the plugin loads, a few seconds after a thread goes idle, is
archived, unarchived or deleted, and every 10 minutes. An idle thread is
re-exported only when it changed; a working thread at most every 5 minutes,
then once more when it settles, so long-working threads are searchable. Each sync
checks which files the host actually has, so a wiped qmd index, a cleared data
directory or a switch to another host rebuilds itself.

The host needs qmd on the bb host daemon's `PATH`, and qmd needs Node.js 22 or
newer (its README also asks for Homebrew's SQLite on macOS, for SQLite
extensions). Search uses only qmd's keyword index, so qmd never downloads its
embedding models. If the daemon's `PATH` lacks qmd (common with nvm or a
GUI-launched daemon), set `searchCommand` to qmd's absolute path. Search shows
qmd's errors, such as a missing CLI, under the search bar.

```sh
npm install -g @tobilu/qmd                       # once, on the host
bb plugin config shop-kanban set searchCommand "$(command -v qmd)"   # only if bb cannot find qmd
qmd --index shop-kanban search "redis timeout"   # same index from a terminal
```

| Setting         | Default | Meaning                                                |
| --------------- | ------- | ------------------------------------------------------ |
| `searchCommand` | `qmd`   | qmd CLI to run. Leave empty to turn thread search off. |

## Work lists

Your pull requests sit in the Queue column, one line each:

- **Outgoing PRs** (the Queue tab, between its threads and Parked): your open
  pull requests, drafts included. Each starts with a mark for whose move it
  is: the red blocked mark when it waits on you (merge conflict, CI failing,
  with the failing checks' names, changes requested, behind its base branch,
  no reviewers requested), a green merge disc when it is approved
  (`Approved · ready to merge`, or `Approved · merge blocked`), the working
  petals while CI runs, an hourglass while it is `Awaiting N reviews`, and
  the draft icon on drafts. Its status follows the title in the same hue.
  The ones waiting on you come first, then the ones you can merge, then the
  rest, newest update first within each; the header counts `N need you` in
  red. The title drafts a thread for the next step: fix CI, answer the
  review comments, resolve the conflict, update the branch, find reviewers,
  or check it is safe to merge.
- **Shipped** (the Out tab): your pull requests merged within `shippedDays`.
  Merging is as close to deployed as the forges tell, so each stays until you
  press both **Measured** and **Demoed** (on hover; one already set stays as
  a badge), or archive it. The title drafts a thread that finds the metrics,
  dashboards or experiments it should move, compares them before and after it
  shipped, and outlines a short demo.

Rows show the age at the end and, on hover, a **Delta** or **GitHub** link
that opens the pull request in your browser and **Archive**, which hides it
for good. Marks and archives are kept in plugin storage (500 per kind).

The searches run through the forge CLIs you already signed in to, `dt` for
Delta and `gh` for GitHub, on the same connected persistent host as thread
search: 10 seconds after the plugin loads, when a setting changes, every 5
minutes (every minute after a failed search), and when the board reads the
lists and the last search is over a minute old. The 5 minutes count time
asleep, so a machine that wakes from a long sleep searches within 30 seconds.
Each line is GitHub search syntax prefixed by its forge; a Delta line without
`repo:` searches `shop/world`, and blank lines and `#` comments are skipped.
A search that can't run here, because no persistent host is connected or
`dt` or `gh` is missing or signed out, is skipped quietly; other failures
show as an amber icon in the list header. Each list shows 8 rows with a
"Show more" button.

Each refresh then reads where every open pull request stands, 4 at a time:
its merge state, each reviewer's latest standing verdict, the reviews still
requested, and CI on its head commit (commit statuses and check runs).
Delta's `reviews` check, which stays in progress until reviewers approve,
counts as review, not CI. A read that fails keeps the last status known and
says why in the header; until the first read lands a row says `Reading
status...`.

| Setting            | Default                                   | Meaning                                                                                                     |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `outgoingSearches` | `delta: author:@me`, `github: author:@me` | Searches for Outgoing PRs, one per line; `is:pr is:open` implied. Leave empty to hide them.                 |
| `shippedSearches`  | `delta: author:@me`, `github: author:@me` | Searches for Shipped; `is:pr is:merged` and a `merged:>=` cutoff implied. Leave empty to hide Shipped.       |
| `shippedDays`      | `30`                                      | Days a merged pull request stays in Shipped.                                                                |

## Agent tools

Every agent gets two tools, for when you ask it to spawn board threads:

- `shop_kanban_spawn_task`: spawn a child thread of the current one.
- `shop_kanban_create_theory_tasks`: spawn one independent thread per theory.

Agents report nothing to the board, which follows live thread state; the
tools carry no standing instructions to call them. The bundled `shop-kanban`
skill says the same.

## CLI

```sh
bb shop-kanban list [--json]
bb shop-kanban add <short-name> -- <prompt> [--json]  # short name: 40 characters at most
bb shop-kanban park <thread-id> [--json]     # idle threads only; exits 1 if the thread is working
bb shop-kanban unpark <thread-id> [--json]
bb shop-kanban remove <thread-id> [--json]   # archives the thread; exits 1 if nothing was archived
```

## Install

From the bb plugin store, or from this repository:

```sh
bb plugin install git:https://github.com/muhammad-siddeek/bb-plugin-shop-kanban.git@^0.32.0
```

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build .
bb plugin reload shop-kanban
```

## Requirements

bb >= 0.47.

## License

MIT
