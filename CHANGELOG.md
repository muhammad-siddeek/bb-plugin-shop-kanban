# Changelog

## Unreleased

- Cards show, flush right in the footer: what the session has spent (when the
  harness reports cost), a ring with the share of the context window in use
  (amber at 70%, red at 90%), and the icon of the harness the thread runs on
  (e.g. omp, Pi, Codex; the same artwork as the bb sidebar).
- Hovering or focusing that group opens a tooltip with the harness, model,
  thinking level, service tier, access mode, exact context tokens with a fill
  bar, and cost.
- The archive button moved to the card's top-right corner and appears on
  hover or focus (always shown on touch devices). The footer keeps the
  updated time and status on the left.

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
