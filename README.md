# opencode-tokens

[![npm](https://img.shields.io/npm/v/opencode-tokens)](https://www.npmjs.com/package/opencode-tokens)
[![CI](https://github.com/Baylar55/opencode-tokens/actions/workflows/ci.yml/badge.svg)](https://github.com/Baylar55/opencode-tokens/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/opencode-tokens)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/opencode-tokens)](LICENSE)

Track and display [opencode](https://opencode.ai) token usage and cost statistics from your terminal.

Reads opencode's local database directly, read-only. No API keys, no network, no dependencies — just Node.js.

```
$ opencode-tokens --since 6w --by week
╭───── opencode usage — Since 2026-09-13 ──────╮
│  Calls: 1,204  │  Tokens: 88.2M  │  Cost: -  │
╰──────────────────────────────────────────────╯

                                Weekly usage (Since 2026-09-13)
┌────────────┬───────┬────────┬────────┬────────┬─────────┬─────────┬───────┬──────┬──────────┐
│ Week of    │ Calls │  Input │ Output │ Reason │ Cache R │ Cache W │ Total │ Cost │ Trend    │
├────────────┼───────┼────────┼────────┼────────┼─────────┼─────────┼───────┼──────┼──────────┤
│ 2026-10-19 │   243 │ 690.8K │ 133.0K │ 110.1K │   22.7M │       0 │ 23.6M │    - │ ███████░ │
│ 2026-10-12 │   439 │   2.5M │ 108.1K │ 318.4K │   24.9M │       0 │ 27.9M │    - │ ████████ │
│ 2026-10-05 │   343 │   1.5M │  76.1K │ 104.1K │   19.0M │       0 │ 20.7M │    - │ ██████░░ │
│ 2026-09-28 │    50 │ 162.1K │  10.4K │   7.2K │    2.1M │       0 │  2.3M │    - │ █░░░░░░░ │
│ 2026-09-21 │   129 │ 484.0K │  23.3K │  23.1K │   13.3M │       0 │ 13.8M │    - │ ████░░░░ │
└────────────┴───────┴────────┴────────┴────────┴─────────┴─────────┴───────┴──────┴──────────┘
```

## Features

- **Time breakdowns** — usage per `day`, `week` or `month` with trend bars.
- **Group by** `model`, `provider`, `agent` (with per-model detail), `project` or `session`.
- **Filters** — narrow to a model, provider, agent or project.
- **Flexible ranges** — `--days`, `--since`, `--until`, or `--since all`.
- **Period comparison** (`--compare`) — percentage change against the previous period.
- **Export** — `--json` for scripts and dashboards, `--csv` for spreadsheets.
- **Safe** — opens the database read-only; works while opencode is running.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`)
- opencode **v2+** (stores history in `opencode.db`)

## Install

Run without installing:

```bash
npx opencode-tokens
# or
pnpm dlx opencode-tokens
bunx opencode-tokens
```

Or install globally:

```bash
npm install -g opencode-tokens
opencode-tokens
```

## Usage

```bash
# Daily breakdown for the last 7 days (default)
opencode-tokens

# Last 30 days, top 5 models
opencode-tokens --since 30d --by model --limit 5

# This week vs. last week, by project
opencode-tokens --days 7 --by project --compare

# Weekly totals for the last 3 months
opencode-tokens --since 3m --by week

# Monthly totals for all history
opencode-tokens --since all --by month

# Exactly October 2026 (--until is exclusive)
opencode-tokens --since 2026-10-01 --until 2026-11-01 --by model

# Which agents used which models, only for Anthropic models
opencode-tokens --by agent --provider anthropic

# Sessions in one project
opencode-tokens --by session --project my-app --limit 10

# Export
opencode-tokens --since 30d --by model --json > usage.json
opencode-tokens --since all --by day --csv > usage.csv
```

## Options

| Option | Description |
| --- | --- |
| `--days N` | Last N days (default: 7) |
| `--since SPEC` | Start of range: `3h`, `7d`, `2w`, `6m`, an ISO date (`2026-10-01`), or `all` |
| `--until SPEC` | End of range (exclusive), same format as `--since`. Default: now |
| `--compare` | Compare with the previous period of the same length |
| `--by DIM` | `day` (default), `week`, `month`, `model`, `provider`, `agent`, `project`, `session` |
| `--limit N` | Max rows to display |
| `--model TEXT` | Only models whose `provider/model` contains TEXT |
| `--provider TEXT` | Only providers containing TEXT |
| `--agent TEXT` | Only agents containing TEXT (`build`, `plan`, `explore`, ...) |
| `--project TEXT` | Only projects whose path contains TEXT |
| `--json` | Output as JSON |
| `--csv` | Output as CSV |
| `--db PATH` | Path to `opencode.db` |
| `-h`, `--help` | Show help |
| `-V`, `--version` | Show version |

Filters are case-insensitive and can be combined. `m` in time specs means 30 days.
Set `NO_COLOR=1` to disable colors (colors are also disabled automatically when output is piped).

## How it works

opencode v2 stores every session in a SQLite database:

| OS | Default location |
| --- | --- |
| Linux / macOS | `~/.local/share/opencode/opencode.db` |
| Windows | `%USERPROFILE%\.local\share\opencode\opencode.db` |

If `XDG_DATA_HOME` is set, `$XDG_DATA_HOME/opencode/opencode.db` is used instead. Use `--db` for anything else.

Each completed assistant response counts as one **call**. **Total** is
`input + output + reasoning + cache read + cache write`. **Cost** is what opencode recorded for the
response; free models and subscription plans record `0`, which is shown as `-`.

## JSON output

```jsonc
{
  "period": "Last 7 days",
  "range": { "since": "2026-10-18T08:00:00.000Z", "until": "2026-10-25T08:00:00.000Z" },
  "filters": { "provider": "anthropic" },
  "total": { "label": "total", "calls": 202, "tokens": { "input": 609800, "output": 117100, "reasoning": 91000, "cache_read": 17400000, "cache_write": 0, "total": 18217900 }, "cost": 2.31 },
  "rows": [ /* same shape as total; "model" is added for --by agent, "delta_pct" with --compare */ ],
  "previous_total": { /* only with --compare */ }
}
```

## Development

```bash
git clone https://github.com/Baylar55/opencode-tokens.git
cd opencode-tokens
npm test                       # node:test, no dependencies
node bin/opencode-tokens.js    # run from source
npm link                       # install your checkout as the global command
```

## License

MIT. See [LICENSE](LICENSE).
