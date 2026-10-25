# Changelog

## 0.1.0 — 2026-10-25

Initial release.

- Daily, weekly and monthly usage breakdowns with trend bars.
- Group by model, provider, agent (with per-model detail), project or session.
- Filters: `--model`, `--provider`, `--agent`, `--project`.
- Time ranges: `--days`, `--since`, `--until`, `--since all`; period comparison with `--compare`.
- JSON and CSV export.
- Reads opencode v2's `opencode.db` read-only. Zero dependencies, Node.js 22.13+.
