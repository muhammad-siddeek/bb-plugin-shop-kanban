# Shop Kanban

A Kanban board for [bb](https://getbb.app) threads. It opens as an overlay at
the bottom of the bb app and shows every non-archived top-level thread. Child
threads roll up into their parent thread.

## Columns

Columns are derived from live thread state; the only drags are parking a
thread (see Parked) and starting a waiting one (see Working limit).

- **Queue**: the thread has not started yet (pending, queued, or no output).
  A thread that errored and then got a follow-up stays here while the
  follow-up waits to send, not Blocked in Working. Queue's header has three
  tabs, kept across reloads: **Queue** (these threads), **Radar** (discovered
  opportunities and techniques), and **Out** (your open and recently merged
  pull requests). Out disappears when its settings are empty.
  Incoming work sits at the bottom of Queue, below Parked, with
  pull requests requested of you by name and issues assigned to you. Reviews
  and Assigned appear directly, without an In heading or combined badge.
- **Working**: the thread or one of its descendants has a turn in progress,
  background work included. Blocked threads sit at the top of Working as red cards: the
  thread is idle and needs you (a pending interaction, an error, or a last
  reply that asks a question). The title bar, and the pill when the board is
  hidden, show the Working limit's meter (below) with one red dot per blocked
  thread ahead of it; waiting messages show only in Working's header.
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
  its age while it has no cost). Unread ones come first with a solid
  check, then **Read · Work** (Shopify work) and **Read · Other**, each
  newest finish first. The age is when the thread finished. Read state and
  finish time are bb's own (the sidebar's unread dot), and the column's count
  is its unread cards. The existing labeler classifies the thread's subject
  from its user messages and the agent's reply, not its AI account or other
  board titles: Shopify products, internal systems, company operations and
  Shopify-owned repos are work, including Verdict SDK and ExP; personal
  projects and unrelated tools are other. Without evidence of Shopify work
  it chooses other. Until the first
  classification arrives, read cards sit in Other; existing cards classify
  in the background without retitling them. With the labeler off, cards keep
  their last classification, or stay in Other if they have none.
- **Parked** (grey): a section under the Queue tab, below the queued threads, one line per card. Idle threads you parked to come back to later, such as a
  finished thread whose suggested next steps can wait. Drag an idle card onto
  Parked (it outlines and shows "Drop to park" while you drag), or hover the
  card and press the pause button; a card waiting to start has a play button
  there instead, so drag it. The return button on a parked card unparks it.
  Parked cards keep their status (Completed, Asked a question, ...) and leave
  Parked on their own when the thread starts working again.

## Radar

Radar's red badge counts unresolved recommendations, not opened drafts. An
opportunity shows its best solution; opening it brings up bb's full new-thread
composer with the findings, evidence and instruction to implement that solution.
Cancel leaves it unread. Submit creates the thread using the selected project,
environment and model, moves the opportunity to Read, and opens Queue. The normal
working limit still controls when its thread starts. Dismiss removes a recommendation.
Techniques open their originating Slack message and leave Radar immediately.

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
a steady spend rate: Max 0 to Max 5 working, or No limit. It shows one amber
dot per slot, filled as threads take them (`●●○ 2/3`), with threads over the
limit as slightly smaller amber dots with a hole, and `+2 waiting`
while messages wait; the default is no limit, and the choice is kept across
reloads.

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

- A `[category] intent` title, e.g. `[docs site] search page`. The title is
  written back to the bb sidebar thread title unless you rename the thread
  yourself.
- Queue and Working cards are two rows. The first has the status mark (an
  amber petal spinner while working), the tag and title on one line, and what
  the thread's whole tree has spent; the second has a pie with how full its
  context window is (dim grey, amber at 70%, red at 90%), a one-line summary
  of the latest exchange, and how long ago it was updated (`5m`, `3h`, `2d`).
  Costs show cents under $10 (`$4.30`, `$53`). Working
  threads refresh these every 5 seconds, idle threads every minute.
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
  It takes the button's place and keeps its draft across closes, reloads and
  crashes; the × in its corner or Esc closes it.

### On a phone

Below 640px wide, each column takes the width of the screen with the next
one peeking in, and a swipe snaps to the next column. The title bar gives its
room to search, whose results span the bar. The hidden board is a bottom bar
that reserves its own strip, so it doesn't sit on bb's composer controls. On
touch screens, buttons and toggles are larger and text fields use 16px text,
so iOS doesn't zoom into them.

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
out of CPU, memory, disk or battery. Each gauge is a capsule in the metric's
own color, half transparent, with a solid icon and a percentage cut out of it
so the title bar shows through: blue CPU (chip), red memory (memory stick),
yellow disk (hard drive), green battery. Every gauge reads as danger: a high
number always means trouble, and the capsule turns amber, then red, as it nears
running out. The panel it opens sums it up as Headroom, Busy or Strained.

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
memory, helper processes counted with their app.

The plugin server samples every 2 seconds while a board is open, and stops
30 seconds after the last board closes or is hidden.

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

## Review queue

Open pull requests waiting on your review are the **Reviews** list, first in
the Queue tab's **In** section, newest update first. Only requests of you by
name (Me) are shown; there is no Team toggle. `reviewSearchesMe` lists one
search per line. Empty it to hide Reviews. Team search configuration is
retained but team requests are not displayed on the board.

Each pull request is a two-line card:

- **Line 1**: a risk chip (`LOW`, `MED`, `HIGH`) and the title. Clicking the
  title opens bb's new-thread screen with a drafted, unsent prompt that asks
  the agent to explain the pull request: what changed, why, and how risky it
  is, starting from the model's first read.
- **Line 2**: age, author and number, then three actions:
  - **Delta** or **GitHub** opens the pull request in your browser.
  - **✓** approves. A first click turns it into `Approve?`; a second click
    within 3 seconds submits.
  - **✕** opens a one-line reason box; Enter requests changes with that
    reason, Esc closes it.
- **Archive** (on hover, top right) hides the pull request for good.

New cards are blue and bold until you open them from the board (draft or
forge link); a push of new commits marks them new again. Approving or
requesting changes removes the card at once. A pull request you reviewed,
from the board or anywhere else, stays hidden until commits land after your
review; it then comes back marked `re-review`, and its draft asks what changed
since the commit you reviewed. Errors show on the card, and failed searches
as an amber icon in the list header. A search that can't run here, because
no persistent host is connected or `dt` or `gh` is missing or signed out, is
skipped quietly. The list shows 8 cards with a "Show more" button.

The searches run through the forge CLIs you already signed in to, `dt` for
Delta and `gh` for GitHub, on the same connected persistent host as thread
search: 8 seconds after the plugin loads, when either setting changes, every
5 minutes (every minute after a failed search), and whenever the board reads
the queue and the last search is over a minute old. Opening the board, or
coming back to it after waking the machine, picks up new requests within one
search round. The 5 minutes count time asleep, so a machine that wakes from a
long sleep searches within 30 seconds. Reviews are submitted
as those CLIs' signed-in user. Each line is GitHub search syntax prefixed by
its forge:

- `is:pr is:open` is implied, and GitHub lines skip archived repositories.
- A Delta line without `repo:` searches `shop/world`.
- By name: Delta's `review-requested:@me` matches only requests of you by
  name. GitHub's also matches your teams' requests; its
  `user-review-requested:@me` is the by-name half.
- Teams: Delta's `team-review-requested:@me` matches every team you are on.
  GitHub rejects `@me` there, so the default uses
  `review-requested:@me -user-review-requested:@me`. For one team, Delta
  takes the team slug (`team-review-requested:exp`) and GitHub takes
  `<org>/<team>`.
- Blank lines and `#` comments are skipped.

```sh
# Team: only ExP's requests on Delta
bb plugin config shop-kanban set reviewSearchesTeam 'delta: team-review-requested:exp -author:@me -is:draft'
```

The first read (`[risk] what. why. what could break.`, three sentences at
most) comes from the labeler model (`labelerCommand` and `labelerModels`),
given the description, the size and a clipped diff of the first changed
files, without lockfiles and generated files. It is written once per head
commit and kept in plugin storage. With `labelerCommand` empty, cards show no
risk chip and drafts carry no first read.

| Setting              | Default                                                                                                              | Meaning                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `reviewSearchesMe`   | Delta and GitHub requests of you by name, drafts and your own PRs excluded                                           | Searches for Me, one per line. Leave empty to hide Me.           |
| `reviewSearchesTeam` | Delta requests of any of your teams, GitHub requests of your teams but not of you by name; drafts and your own PRs excluded | Searches for Team, one per line. Leave empty to hide Team. |

## Work lists

Pull requests and issues of yours sit in the Queue column's tabs, drawn like
review cards, newest update first:

- **Open** (Out): your open pull requests, one line each, drafts marked with
  the draft icon. The title drafts a thread that reads the review comments, CI
  checks and merge readiness and says what is left before it can merge.
- **Shipped** (Out): your pull requests merged within `shippedDays`, one line
  each. Merging is as close to deployed as the forges tell, so each stays
  until you press both **Measured** and **Demoed** (on hover; one already set
  stays as a badge), or archive it.
  The title drafts a thread that finds the metrics, dashboards or experiments
  it should move, compares them before and after it shipped, and outlines a
  short demo.
- **Assigned** (In, below Reviews): open issues assigned to you. The
  title drafts a thread that summarizes the issue and proposes how to
  resolve it.

Out rows show the age at the end and, on hover, a **Delta** or **GitHub**
link that opens it in your browser; Assigned has them on its second line with
the number. **Archive** (on hover, top right) hides one
for good. Marks and archives are kept in plugin storage (500 per kind). The
searches run like review searches: through `dt` and `gh` on the connected
persistent host, 10 seconds after the plugin loads, when a setting changes,
every 5 minutes (every minute after a failed search), and when the board
reads the lists and the last search is over a minute old. Each list shows 8
cards with a "Show more" button. Delta has no issues, so Assigned reads only
GitHub.

| Setting            | Default                                   | Meaning                                                                                               |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `outgoingSearches` | `delta: author:@me`, `github: author:@me` | Searches for Open, one per line; `is:pr is:open` implied. Leave empty to hide Open.                   |
| `shippedSearches`  | `delta: author:@me`, `github: author:@me` | Searches for Shipped; `is:pr is:merged` and a `merged:>=` cutoff implied. Leave empty to hide Shipped. |
| `shippedDays`      | `30`                                      | Days a merged pull request stays in Shipped.                                                          |
| `assignedSearches` | `github: assignee:@me`                    | Searches for Assigned; `is:issue is:open` implied. Leave empty to hide Assigned.                      |

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
bb plugin install git:https://github.com/muhammad-siddeek/bb-plugin-shop-kanban.git@^0.23.0
```

## Development

```sh
npm install
npm run typecheck
bb plugin build .
bb plugin reload shop-kanban
```

## Requirements

bb >= 0.47.

## License

MIT
