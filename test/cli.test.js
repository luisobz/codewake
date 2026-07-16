import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveRunAt, usage } from '../lib/cli.js';
import { renderJobsTable } from '../lib/wizard.js';

test('no arguments opens the interactive console', () => {
  assert.deepEqual(parseArgs([]), { command: 'wizard' });
});

test('management commands parse', () => {
  assert.equal(parseArgs(['jobs']).command, 'jobs');
  assert.equal(parseArgs(['list']).command, 'jobs');
  assert.equal(parseArgs(['agents']).command, 'agents');
  assert.equal(parseArgs(['clear']).command, 'clear');
  assert.deepEqual(parseArgs(['cancel', 'abc']), { command: 'cancel', jobId: 'abc' });
  assert.deepEqual(parseArgs(['logs', 'abc']), { command: 'logs', jobId: 'abc' });
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-v']).command, 'version');
});

test('cancel and logs require a job id', () => {
  assert.throws(() => parseArgs(['cancel']), /cancel <job-id>/);
  assert.throws(() => parseArgs(['logs']), /logs <job-id>/);
});

test('unknown commands point to help', () => {
  assert.throws(() => parseArgs(['bogus']), /Unknown command: bogus/);
});

test('schedule parses a full resume invocation', () => {
  const args = parseArgs([
    'schedule',
    '--agent', 'claude',
    '--session', 'abc-123',
    '--prompt', 'keep going',
    '--skip-permissions',
    '--in', '2h30m',
    '--dry-run',
  ]);
  assert.equal(args.command, 'schedule');
  assert.equal(args.agentId, 'claude');
  assert.equal(args.sessionId, 'abc-123');
  assert.equal(args.prompt, 'keep going');
  assert.equal(args.skipPermissions, true);
  assert.deepEqual(args.when, { type: 'in', value: '2h30m' });
  assert.equal(args.dryRun, true);
});

test('schedule validates flag combinations', () => {
  assert.throws(() => parseArgs(['schedule']), /--agent is required/);
  assert.throws(() => parseArgs(['schedule', '--agent', 'claude']), /--session <id> to resume, or --new/);
  assert.throws(
    () => parseArgs(['schedule', '--agent', 'claude', '--session', 'a', '--new']),
    /either --session or --new/,
  );
  assert.throws(
    () => parseArgs(['schedule', '--agent', 'claude', '--new']),
    /--prompt is required when starting a new session/,
  );
  assert.throws(() => parseArgs(['schedule', '--agent']), /--agent needs a value/);
  assert.throws(
    () => parseArgs(['schedule', '--agent', 'claude', '--session', 'a', '--frobnicate']),
    /Unknown option: --frobnicate/,
  );
});

test('resolveRunAt handles now, delays and clock times', () => {
  const now = new Date('2026-07-16T10:00:00');
  assert.equal(resolveRunAt({ type: 'now' }, now).getTime(), now.getTime());
  assert.equal(
    resolveRunAt({ type: 'in', value: '90m' }, now).getTime(),
    now.getTime() + 90 * 60 * 1000,
  );
  const at = resolveRunAt({ type: 'at', value: '06:00' }, now);
  assert.equal(at.getHours(), 6);
  assert.ok(at > now);
});

test('usage mentions every command', () => {
  const text = usage();
  for (const command of ['jobs', 'logs', 'cancel', 'clear', 'agents', 'schedule', '--dry-run']) {
    assert.ok(text.includes(command), `usage mentions ${command}`);
  }
});

test('renderJobsTable aligns columns and shows status', () => {
  const now = Date.now();
  const table = renderJobsTable([
    {
      id: 'job-1',
      agentName: 'Claude Code',
      status: 'pending',
      runAt: new Date(now + 3600_000).toISOString(),
      mode: 'resume',
      sessionId: '550e8400-e29b-41d4',
      project: '/work/demo',
    },
    {
      id: 'job-2',
      agentName: 'OpenAI Codex CLI',
      status: 'done',
      runAt: new Date(now - 3600_000).toISOString(),
      mode: 'create',
      sessionId: null,
      project: '/work/demo',
    },
  ], now);
  const lines = table.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /ID\s+AGENT\s+STATUS\s+LAUNCH\s+SESSION\s+PROJECT/);
  assert.match(lines[1], /job-1\s+Claude Code\s+pending\s+in 1h/);
  assert.match(lines[1], /550e8400-e29/);
  assert.match(lines[2], /job-2\s+OpenAI Codex CLI\s+done/);
  assert.match(lines[2], /new session/);
});
