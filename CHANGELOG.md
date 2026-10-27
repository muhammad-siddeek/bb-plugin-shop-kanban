# Changelog

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
