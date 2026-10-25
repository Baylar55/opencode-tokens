// Track and display opencode token usage. Reads opencode.db read-only; zero dependencies.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const GROUPS = ['day', 'week', 'month', 'model', 'provider', 'agent', 'project', 'session'];

const HELP = `opencode-tokens — token usage and cost statistics for opencode

usage: opencode-tokens [options]

time range:
  --days N         Last N days (default: 7)
  --since SPEC     Start: '3h', '7d', '2w', '6m', ISO date ('2026-10-01'), or 'all'
  --until SPEC     End (exclusive), same format as --since (default: now)
  --compare        Compare with the previous period of the same length

grouping & filters:
  --by DIM         Group by: ${GROUPS.join(', ')} (default: day)
  --limit N        Max rows to display
  --model TEXT     Only models whose "provider/model" contains TEXT
  --provider TEXT  Only providers containing TEXT
  --agent TEXT     Only agents containing TEXT (build, plan, explore, ...)
  --project TEXT   Only projects whose path contains TEXT

output:
  --json           Output as JSON
  --csv            Output as CSV
  --db PATH        Path to opencode.db (default: $XDG_DATA_HOME/opencode/opencode.db)
  -h, --help       Show this help
  -V, --version    Show version

Filters are case-insensitive. Set NO_COLOR=1 to disable colors.`;

// ---------- data ----------

const MODEL = "CASE WHEN provider = 'unknown' THEN model ELSE provider || '/' || model END";
const local = "ts / 1000, 'unixepoch', 'localtime'";

const DIMS = {
  day: { label: `date(${local})`, time: 'Daily' },
  week: { label: `date(${local}, 'weekday 0', '-6 days')`, time: 'Weekly' }, // Monday of the week
  month: { label: `strftime('%Y-%m', ${local})`, time: 'Monthly' },
  model: { label: MODEL },
  provider: { label: 'provider' },
  agent: { label: 'agent', detail: MODEL, group: 'label, detail', order: 'label, total DESC, detail' },
  project: { label: 'project' },
  session: { label: 'title', group: 'session_id' },
  total: { label: "'total'" },
};

const FILTERS = { model: MODEL, provider: 'provider', agent: 'agent', project: 'project' };

export function defaultDbPath() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'opencode', 'opencode.db');
}

export function openDb(path) {
  if (!existsSync(path)) {
    throw new Error(`opencode database not found: ${path}\nIs opencode v2 installed and used at least once? Use --db PATH to point at it.`);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_message'").get()) {
    db.close();
    throw new Error(`${path} has no session_message table. opencode-tokens requires opencode v2 or newer.`);
  }
  return db;
}

export function query(db, dim, { since = 0, until = Number.MAX_SAFE_INTEGER, limit = -1, filters = {} } = {}) {
  const d = DIMS[dim];
  const active = Object.entries(filters).filter(([k, v]) => FILTERS[k] && v);
  const where = active.map(([k]) => `instr(lower(${FILTERS[k]}), lower(?)) > 0`);
  const sql = `
    WITH m AS (
      SELECT sm.session_id, sm.time_created AS ts,
        COALESCE(s.title, s.slug, sm.session_id) AS title,
        CASE WHEN p.worktree IS NULL OR p.worktree = '/' THEN COALESCE(s.directory, 'unknown') ELSE p.worktree END AS project,
        COALESCE(json_extract(sm.data, '$.agent'), 'unknown')            AS agent,
        COALESCE(json_extract(sm.data, '$.model.providerID'), 'unknown') AS provider,
        COALESCE(json_extract(sm.data, '$.model.id'), 'unknown')         AS model,
        COALESCE(json_extract(sm.data, '$.tokens.input'), 0)       AS input,
        COALESCE(json_extract(sm.data, '$.tokens.output'), 0)      AS output,
        COALESCE(json_extract(sm.data, '$.tokens.reasoning'), 0)   AS reasoning,
        COALESCE(json_extract(sm.data, '$.tokens.cache.read'), 0)  AS cache_read,
        COALESCE(json_extract(sm.data, '$.tokens.cache.write'), 0) AS cache_write,
        COALESCE(json_extract(sm.data, '$.cost'), 0)               AS cost
      FROM session_message sm
      LEFT JOIN session_v2 s ON s.id = sm.session_id
      LEFT JOIN project p ON p.id = s.project_id
      WHERE sm.type = 'assistant'
        AND json_extract(sm.data, '$.tokens') IS NOT NULL
        AND sm.time_created >= ? AND sm.time_created < ?
    )
    SELECT ${d.label} AS label, ${d.detail ?? 'NULL'} AS detail,
      COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(reasoning) AS reasoning,
      SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
      SUM(input + output + reasoning + cache_read + cache_write) AS total, SUM(cost) AS cost
    FROM m
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY ${d.group ?? 'label'}
    ORDER BY ${d.time ? 'label DESC' : (d.order ?? 'total DESC, label')}
    LIMIT ?`;
  return db.prepare(sql).all(since, until, ...active.map(([, v]) => v), limit);
}

const EMPTY = { label: 'total', detail: null, calls: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 };
const totals = (db, opts) => query(db, 'total', { ...opts, limit: -1 })[0] ?? EMPTY;

const toJson = (r) => ({
  label: r.label,
  ...(r.detail != null && { model: r.detail }),
  calls: r.calls,
  tokens: { input: r.input, output: r.output, reasoning: r.reasoning, cache_read: r.cache_read, cache_write: r.cache_write, total: r.total },
  cost: Math.round(r.cost * 1e4) / 1e4,
});

export function toCsv(rows, deltas) {
  const esc = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const agent = rows.some((r) => r.detail != null);
  const head = ['label', ...(agent ? ['model'] : []), 'calls', 'input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total', 'cost', ...(deltas ? ['delta_pct'] : [])];
  const lines = rows.map((r, i) =>
    [r.label, ...(agent ? [r.detail ?? ''] : []), r.calls, r.input, r.output, r.reasoning, r.cache_read, r.cache_write, r.total,
      Math.round(r.cost * 1e4) / 1e4, ...(deltas ? [deltas[i] == null ? '' : deltas[i].toFixed(1)] : [])].map(esc).join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

// ---------- args ----------

const DAY = 86400e3;

export function parseTime(value, now = Date.now()) {
  if (value.trim().toLowerCase() === 'all') return 0;
  const m = /^(\d+)([hdwm])$/i.exec(value.trim());
  if (m) return now - Number(m[1]) * { h: DAY / 24, d: DAY, w: 7 * DAY, m: 30 * DAY }[m[2].toLowerCase()];
  // Date-only ISO strings parse as UTC in JS; treat them as local midnight instead.
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value).getTime();
  if (Number.isNaN(t)) throw new Error(`Invalid time spec: '${value}'. Use '7d', '2w', '30d', '3h', an ISO date, or 'all'.`);
  return t;
}

function positiveInt(name, v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

const ymd = (t) => new Date(t).toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time

export function resolveRange({ since, until, days }, now = Date.now()) {
  const end = until !== undefined ? parseTime(until, now) : now;
  if (since !== undefined) {
    const start = parseTime(since, now);
    const label = start === 0 ? 'All time' : `Since ${ymd(start)}`;
    return { since: start, until: end, period: until !== undefined ? `${start === 0 ? 'Until' : `${ymd(start)} →`} ${ymd(end)}` : label };
  }
  const n = days ?? 7;
  return { since: end - n * DAY, until: end, period: until !== undefined ? `${n} days until ${ymd(end)}` : `Last ${n} days` };
}

export function computeDeltas(current, previous) {
  const key = (r) => (r.detail ? `${r.label}:${r.detail}` : r.label);
  const prev = new Map();
  for (const r of previous) prev.set(key(r), (prev.get(key(r)) ?? 0) + r.total);
  return current.map((r) => {
    const p = prev.get(key(r)) ?? 0;
    return p > 0 ? ((r.total - p) / p) * 100 : null;
  });
}

// ---------- render ----------

const paint = (style, s) => (style ? styleText(style, s) : s);

export function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(c) {
  if (!c || c <= 0) return '-';
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function sparkBar(value, max, width = 8) {
  if (max <= 0 || value <= 0) return '░'.repeat(width);
  const filled = Math.min(width, Math.max(1, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Returns [text, style] so widths can be computed before ANSI codes are added.
function fmtDelta(pct) {
  if (pct > 0) return [`↑${pct.toFixed(0)}%`, 'red'];
  if (pct < 0) return [`↓${Math.abs(pct).toFixed(0)}%`, 'green'];
  return ['→0%', 'dim'];
}

const MAX_LABEL = 50;
const truncate = (s, keepEnd) =>
  s.length <= MAX_LABEL ? s : keepEnd ? `…${s.slice(-(MAX_LABEL - 1))}` : `${s.slice(0, MAX_LABEL - 1)}…`;

// cols: [{ name, right?, style? }]; rows: arrays of string | [text, style]; null row = section separator.
function drawTable(title, cols, rows) {
  const text = (v) => (Array.isArray(v) ? v[0] : v);
  const w = cols.map((c, i) => Math.max(c.name.length, ...rows.filter(Boolean).map((r) => text(r[i]).length)));
  const line = (l, m, r) => paint('dim', l + w.map((n) => '─'.repeat(n + 2)).join(m) + r);
  const pad = (s, i) => (cols[i].right ? s.padStart(w[i]) : s.padEnd(w[i]));
  const bar = paint('dim', '│');
  const row = (cells) => `${bar} ${cells.join(` ${bar} `)} ${bar}`;
  const width = w.reduce((a, b) => a + b + 3, 1);
  console.log([
    ' '.repeat(Math.max(0, (width - title.length) >> 1)) + paint('bold', title),
    line('┌', '┬', '┐'),
    row(cols.map((c, i) => paint(['bold', 'cyan'], pad(c.name, i)))),
    line('├', '┼', '┤'),
    ...rows.map((r) => (r ? row(r.map((v, i) => paint(Array.isArray(v) ? v[1] : cols[i].style, pad(text(v), i)))) : line('├', '┼', '┤'))),
    line('└', '┴', '┘'),
  ].join('\n'));
}

function renderSummary(total, period, prev) {
  const pct = (cur, p) => (p > 0 ? [[' '], fmtDelta(((cur - p) / p) * 100)] : []);
  const parts = [
    ['Calls: ', 'dim'], [total.calls.toLocaleString('en-US'), ['bold', 'magenta']], ...pct(total.calls, prev?.calls),
    ['  │  Tokens: ', 'dim'], [fmtTokens(total.total), 'bold'], ...pct(total.total, prev?.total),
    ['  │  Cost: ', 'dim'], [fmtCost(total.cost), ['bold', 'red']], ...pct(total.cost, prev?.cost),
  ];
  const len = parts.reduce((n, [t]) => n + t.length, 0);
  const title = ` opencode usage — ${period} `;
  const inner = Math.max(len + 4, title.length + 4);
  const left = (inner - title.length) >> 1;
  const b = (s) => paint('blue', s);
  console.log([
    b(`╭${'─'.repeat(left)}`) + paint('bold', title) + b(`${'─'.repeat(inner - left - title.length)}╮`),
    `${b('│')}  ${parts.map(([t, s]) => paint(s, t)).join('')}${' '.repeat(inner - len - 2)}${b('│')}`,
    b(`╰${'─'.repeat(inner)}╯`),
  ].join('\n'));
}

const HEADERS = { day: 'Date', week: 'Week of', month: 'Month', model: 'Model', provider: 'Provider', agent: 'Agent', project: 'Project', session: 'Session' };

function renderRows(rows, by, period, deltas) {
  if (!rows.length) return console.log(paint('dim', `No usage found for ${period.toLowerCase()}.`));
  const header = HEADERS[by];
  const time = DIMS[by].time;
  const cols = [{ name: header, style: 'bold' }];
  if (by === 'agent') cols.push({ name: 'Model', style: ['dim', 'cyan'] });
  cols.push(
    { name: 'Calls', right: true, style: 'magenta' },
    { name: 'Input', right: true, style: 'green' },
    { name: 'Output', right: true, style: 'yellow' },
    { name: 'Reason', right: true, style: 'yellow' },
    { name: 'Cache R', right: true, style: 'dim' },
    { name: 'Cache W', right: true, style: 'dim' },
    { name: 'Total', right: true, style: 'bold' },
    { name: 'Cost', right: true, style: ['bold', 'red'] },
  );
  if (time) cols.push({ name: 'Trend', style: 'cyan' });
  if (deltas) cols.push({ name: 'Δ', right: true });

  const max = Math.max(0, ...rows.map((r) => r.total));
  const out = [];
  let prevLabel = null;
  rows.forEach((r, i) => {
    if (by === 'agent' && prevLabel !== null && r.label !== prevLabel) out.push(null);
    const cells = [r.label === prevLabel ? '' : truncate(r.label, by === 'project')];
    prevLabel = r.label;
    if (by === 'agent') cells.push(r.detail ?? '');
    cells.push(String(r.calls), ...[r.input, r.output, r.reasoning, r.cache_read, r.cache_write, r.total].map(fmtTokens), fmtCost(r.cost));
    if (time) cells.push(sparkBar(r.total, max));
    if (deltas) cells.push(deltas[i] == null ? ['-', 'dim'] : fmtDelta(deltas[i]));
    out.push(cells);
  });
  drawTable(time ? `${time} usage (${period})` : `Usage by ${header.toLowerCase()} (${period})`, cols, out);
}

// ---------- main ----------

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'run') argv = argv.slice(1); // compatibility with omp-usage style
  const str = { type: 'string' };
  const { values: a } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
      days: str, since: str, until: str, by: str, limit: str,
      model: str, provider: str, agent: str, project: str,
      json: { type: 'boolean' }, csv: { type: 'boolean' }, compare: { type: 'boolean' },
      db: str,
    },
  });
  if (a.help) return console.log(HELP);
  if (a.version) return console.log(VERSION);

  const by = a.by ?? 'day';
  if (!GROUPS.includes(by)) throw new Error(`--by must be one of: ${GROUPS.join(', ')}`);
  if (a.json && a.csv) throw new Error('use either --json or --csv, not both');
  const limit = positiveInt('limit', a.limit) ?? -1;
  const { since, until, period } = resolveRange({ since: a.since, until: a.until, days: positiveInt('days', a.days) });
  if (since >= until) throw new Error('--since must be before --until');
  if (a.compare && since === 0) throw new Error('--compare needs a bounded period (not --since all)');
  const filters = { model: a.model, provider: a.provider, agent: a.agent, project: a.project };

  const db = openDb(a.db ?? defaultDbPath());
  let rows, total, prevTotal, prevRows = [];
  try {
    rows = query(db, by, { since, until, limit, filters });
    total = totals(db, { since, until, filters });
    if (a.compare) {
      const prev = { since: since - (until - since), until: since, filters };
      prevTotal = totals(db, prev);
      prevRows = query(db, by, { ...prev, limit: -1 });
    }
  } finally {
    db.close();
  }
  // Time buckets never overlap between periods, so per-row deltas only make sense for other groupings.
  const deltas = a.compare && !DIMS[by].time ? computeDeltas(rows, prevRows) : null;

  if (a.json) {
    const out = {
      period,
      range: { since: since ? new Date(since).toISOString() : null, until: new Date(until).toISOString() },
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      total: toJson(total),
      rows: rows.map((r, i) => ({ ...toJson(r), ...(deltas && { delta_pct: deltas[i] }) })),
    };
    if (prevTotal) out.previous_total = toJson(prevTotal);
    return console.log(JSON.stringify(out, null, 2));
  }
  if (a.csv) return console.log(toCsv(rows, deltas));

  renderSummary(total, period, prevTotal);
  console.log();
  renderRows(rows, by, period, deltas);
}
