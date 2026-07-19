import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describeJobHeader, parseArgs, resolveRunAt, usage } from '../lib/cli.js';
import { renderJobsTable, shortenPath } from '../lib/wizard.js';

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

test('retry parses the job id and its timing flags', () => {
  assert.deepEqual(parseArgs(['retry', 'abc']), {
    command: 'retry',
    jobId: 'abc',
    when: { type: 'now' },
    prompt: null,
    project: null,
    dryRun: false,
  });
  const args = parseArgs(['retry', 'abc', '--in', '5s', '--prompt', 'keep going', '--project', '/tmp/x', '--dry-run']);
  assert.deepEqual(args.when, { type: 'in', value: '5s' });
  assert.equal(args.prompt, 'keep going');
  assert.equal(args.project, resolve('/tmp/x'));
  assert.equal(args.dryRun, true);
  assert.throws(() => parseArgs(['retry']), /retry <job-id>/);
  assert.throws(() => parseArgs(['retry', 'abc', '--frobnicate']), /Unknown option/);
  assert.throws(() => parseArgs(['retry', 'abc', '--in']), /--in needs a value/);
});

test('open parses and requires a job id', () => {
  assert.deepEqual(parseArgs(['open', 'abc']), { command: 'open', jobId: 'abc', skipPermissions: false });
  assert.deepEqual(
    parseArgs(['open', 'abc', '--skip-permissions']),
    { command: 'open', jobId: 'abc', skipPermissions: true },
  );
  assert.throws(() => parseArgs(['open']), /open <job-id>/);
  assert.throws(() => parseArgs(['open', 'abc', '--nope']), /Unknown option/);
});

test('describeJobHeader summarizes status, timing and errors', () => {
  const failed = {
    id: 'job-9',
    agentName: 'Claude Code',
    status: 'failed',
    exitCode: 1,
    runAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    project: '/work/demo',
    error: 'something broke',
  };
  const header = describeJobHeader(failed);
  assert.match(header, /job-9 · Claude Code · failed \(exit 1\)/);
  assert.match(header, /started .* in \/work\/demo/);
  assert.match(header, /error: something broke/);

  const pending = {
    id: 'job-2',
    agentName: 'Goose',
    status: 'pending',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    project: '/work/demo',
  };
  assert.match(describeJobHeader(pending), /pending[\s\S]*scheduled for/);
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
  for (const command of ['jobs', 'open', 'logs', 'cancel', 'retry', 'clear', 'agents', 'schedule', '--dry-run']) {
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
  assert.match(lines[1], /550e8400-e2…/);
  assert.match(lines[2], /job-2\s+OpenAI Codex CLI\s+done/);
  assert.match(lines[2], /new session/);
});

test('renderJobsTable always fits the terminal width', () => {
  const now = Date.now();
  const jobs = [{
    id: 'job-1',
    agentName: 'Claude Code',
    status: 'pending',
    runAt: new Date(now + 3600_000).toISOString(),
    mode: 'resume',
    sessionId: '550e8400-e29b-41d4',
    project: '/very/long/project/path/that/goes/on/and/on/and/never/seems/to/stop/demo-app',
  }];
  const wide = renderJobsTable(jobs, now, { width: 100 });
  for (const line of wide.split('\n')) {
    assert.ok(line.length <= 100, `"${line}" fits in 100 columns (${line.length})`);
  }
  assert.match(wide, /…/);
  assert.match(wide, /demo-app/, 'the tail of the path is preserved');

  // Too narrow for paths: the PROJECT column is dropped entirely.
  const narrow = renderJobsTable(jobs, now, { width: 60 });
  assert.ok(!narrow.includes('PROJECT'));
  assert.match(narrow, /job-1/);
});

test('shortenPath abbreviates the home directory and keeps path tails', () => {
  assert.equal(shortenPath('/home/dev/work/app', 40, '/home/dev'), '~/work/app');
  const shortened = shortenPath('/home/dev/some/extremely/deep/nested/dir', 16, '/home/dev');
  assert.ok(shortened.length <= 16);
  assert.ok(shortened.startsWith('…'));
  assert.ok(shortened.endsWith('dir'));
});
