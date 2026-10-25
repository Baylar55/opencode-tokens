import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseTime, resolveRange, computeDeltas, fmtTokens, fmtCost, sparkBar, query, toCsv } from '../src/cli.js';

const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('parseTime', () => {
  const now = 1_000_000_000_000;
  assert.equal(parseTime('3h', now), now - 3 * 3600e3);
  assert.equal(parseTime('2W', now), now - 14 * 86400e3);
  assert.equal(parseTime('all', now), 0);
  assert.equal(parseTime('2026-01-02', now), local(2026, 1, 2, 0));
  assert.throws(() => parseTime('soon', now));
});

test('resolveRange', () => {
  const now = local(2026, 10, 25);
  assert.deepEqual(resolveRange({}, now), { since: now - 7 * 86400e3, until: now, period: 'Last 7 days' });
  assert.equal(resolveRange({ since: 'all' }, now).period, 'All time');
  const r = resolveRange({ since: '2026-10-01', until: '2026-11-01' }, now);
  assert.equal(r.period, '2026-10-01 → 2026-11-01');
  assert.equal(r.until, local(2026, 11, 1, 0));
});

test('formatting', () => {
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1_500_000), '1.5M');
  assert.equal(fmtCost(0), '-');
  assert.equal(fmtCost(0.005), '$0.0050');
  assert.equal(sparkBar(1, 100, 4), '█░░░');
});

test('computeDeltas', () => {
  const r = (label, total, detail) => ({ label, total, detail });
  assert.deepEqual(computeDeltas([r('a', 150), r('b', 10)], [r('a', 100)]), [50, null]);
});

test('toCsv escapes', () => {
  const row = { label: 'a, "b"', detail: null, calls: 1, input: 1, output: 2, reasoning: 0, cache_read: 0, cache_write: 0, total: 3, cost: 0.12345 };
  assert.equal(toCsv([row], [null]).split('\n')[1], '"a, ""b""",1,1,2,0,0,0,3,0.1235,');
});

test('query aggregates assistant messages', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE project (id TEXT, worktree TEXT);
    CREATE TABLE session_v2 (id TEXT, project_id TEXT, title TEXT, slug TEXT, directory TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
    INSERT INTO project VALUES ('p1', '/code/app'), ('global', '/');
    INSERT INTO session_v2 VALUES ('s1', 'p1', 'My session', 'x', '/code/app'), ('s2', 'global', NULL, 'misty-comet', '/tmp/scratch');`);
  const ins = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  const msg = (agent, provider, cost) => JSON.stringify({ agent, cost, model: { id: 'm', providerID: provider },
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 100, write: 5 } } });
  ins.run('1', 's1', 'assistant', local(2026, 10, 21), msg('build', 'anthropic', 0.5)); // Wednesday
  ins.run('2', 's1', 'assistant', local(2026, 10, 25), msg('plan', 'openai', 0.25)); // Sunday, same week
  ins.run('3', 's2', 'assistant', local(2026, 10, 26), msg('build', 'openai', 0)); // next Monday
  ins.run('4', 's1', 'user', local(2026, 10, 21), '{}');
  ins.run('5', 's1', 'assistant', local(2026, 10, 21), JSON.stringify({ agent: 'build' })); // streaming, no tokens

  const sessions = query(db, 'session');
  assert.deepEqual(sessions.map((r) => [r.label, r.calls, r.total]), [['My session', 2, 240], ['misty-comet', 1, 120]]);
  assert.equal(sessions[0].cost, 0.75);
  assert.deepEqual(query(db, 'agent').map((r) => [r.label, r.detail]), [['build', 'anthropic/m'], ['build', 'openai/m'], ['plan', 'openai/m']]);
  assert.deepEqual(query(db, 'week').map((r) => [r.label, r.calls]), [['2026-10-26', 1], ['2026-10-19', 2]]);
  assert.deepEqual(query(db, 'month').map((r) => r.label), ['2026-10']);
  assert.deepEqual(query(db, 'project').map((r) => r.label), ['/code/app', '/tmp/scratch']);
  assert.equal(query(db, 'model', { since: local(2026, 10, 22) })[0].calls, 2);
  assert.equal(query(db, 'model', { filters: { model: 'ANTHROPIC' } })[0].calls, 1);
  assert.deepEqual(query(db, 'day', { filters: { project: 'scratch', agent: 'build' } }).map((r) => r.calls), [1]);
});
