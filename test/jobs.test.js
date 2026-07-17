import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { encodeClaudeProject } from '../lib/sessions.js';
import {
  cancelJob,
  clearJobs,
  displayStatus,
  listJobs,
  loadJob,
  logFile,
  runJob,
  saveJob,
  scheduleJob,
  systemdCalendarSpec,
  waitJob,
} from '../lib/jobs.js';

const onWindows = process.platform === 'win32';

const claude = { id: 'claude', name: 'Claude Code' };

function makeEnv() {
  return {
    CODEWAKE_STATE_DIR: mkdtempSync(join(tmpdir(), 'codewake-state-')),
    CODEWAKE_BACKEND: 'spawn',
  };
}

function spec(overrides = {}) {
  return {
    agent: claude,
    bin: process.execPath,
    args: ['-e', 'console.log("agent ran")'],
    mode: 'resume',
    sessionId: 'abc',
    prompt: 'continue',
    skipPermissions: false,
    project: process.cwd(),
    runAt: new Date(),
    ...overrides,
  };
}

test('scheduleJob with dryRun writes nothing', () => {
  const env = makeEnv();
  const job = scheduleJob(spec(), { dryRun: true, env });
  assert.equal(job.status, 'pending');
  assert.deepEqual(listJobs(env), []);
});

test('scheduleJob rejects a missing project directory', () => {
  const env = makeEnv();
  assert.throws(
    () => scheduleJob(spec({ project: '/definitely/not/here' }), { dryRun: true, env }),
    /does not exist/,
  );
});

test('runJob executes the command, captures the log and marks done', async () => {
  const env = makeEnv();
  const job = saveJob(scheduleJob(spec(), { dryRun: true, env }), env);
  const finished = await runJob(job.id, env);
  assert.equal(finished.status, 'done');
  assert.equal(finished.exitCode, 0);
  assert.match(readFileSync(logFile(job.id, env), 'utf8'), /agent ran/);
  assert.equal(loadJob(job.id, env).status, 'done');
});

test('runJob marks failures with the exit code', async () => {
  const env = makeEnv();
  const job = saveJob(scheduleJob(spec({ args: ['-e', 'process.exit(3)'] }), { dryRun: true, env }), env);
  const finished = await runJob(job.id, env);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.exitCode, 3);
});

test('runJob survives a missing executable and logs the reason', async () => {
  const env = makeEnv();
  const job = saveJob(scheduleJob(spec({ bin: '/nonexistent/agent' }), { dryRun: true, env }), env);
  const finished = await runJob(job.id, env);
  assert.equal(finished.status, 'failed');
  assert.ok(finished.error);
  assert.match(readFileSync(logFile(job.id, env), 'utf8'), /codewake: /);
});

test('runJob fails with a clear error when the project directory vanished', async () => {
  const env = makeEnv();
  const project = mkdtempSync(join(tmpdir(), 'codewake-gone-'));
  const job = saveJob(
    scheduleJob(spec({ project, mode: 'create', sessionId: null }), { dryRun: true, env }),
    env,
  );
  rmSync(project, { recursive: true, force: true });
  const finished = await runJob(job.id, env);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /no longer exists/);
  assert.match(readFileSync(logFile(job.id, env), 'utf8'), /no longer exists/);
});

test('runJob relaunches a resume job from the directory its session lives in', async () => {
  // The project was renamed between scheduling and firing; the session store
  // still knows the real directory, so the job must follow it.
  const env = makeEnv();
  env.HOME = mkdtempSync(join(tmpdir(), 'codewake-run-home-'));
  env.CODEWAKE_CONFIG = join(env.HOME, 'missing-config.json');
  const realProject = mkdtempSync(join(tmpdir(), 'codewake-run-real-'));
  const staleProject = mkdtempSync(join(tmpdir(), 'codewake-run-stale-'));
  const dir = join(env.HOME, '.claude', 'projects', encodeClaudeProject(realProject));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sess-reloc.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: realProject, message: { content: 'hi' } })}\n`,
  );
  const job = saveJob(
    scheduleJob(spec({ sessionId: 'sess-reloc', project: staleProject }), { dryRun: true, env }),
    env,
  );
  const finished = await runJob(job.id, env);
  assert.equal(finished.status, 'done');
  assert.equal(finished.project, realProject);
  assert.match(readFileSync(logFile(job.id, env), 'utf8'), /codewake: Session sess-reloc belongs to/);
});

test('waitJob runs a due job and skips cancelled ones', async () => {
  const env = makeEnv();
  const due = saveJob(scheduleJob(spec({ runAt: new Date(Date.now() - 1000) }), { dryRun: true, env }), env);
  const finished = await waitJob(due.id, env);
  assert.equal(finished.status, 'done');

  const cancelled = saveJob(
    { ...scheduleJob(spec(), { dryRun: true, env }), status: 'cancelled' },
    env,
  );
  const skipped = await waitJob(cancelled.id, env);
  assert.equal(skipped.status, 'cancelled');
});

test('cancelJob cancels pending jobs and refuses finished ones', () => {
  const env = makeEnv();
  const job = saveJob({ ...scheduleJob(spec(), { dryRun: true, env }), pid: 99999999 }, env);
  const { job: cancelled, warning } = cancelJob(job.id, env);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(warning, null);
  assert.throws(() => cancelJob(job.id, env), /only pending jobs/);
});

test('scheduleJob refuses a second pending job for the same session', () => {
  const env = makeEnv();
  saveJob(scheduleJob(spec({ runAt: new Date(Date.now() + 3600_000) }), { dryRun: true, env }), env);
  assert.throws(() => scheduleJob(spec(), { dryRun: true, env }), /already has a pending job/);
  // A different session, or a brand new session, is fine.
  scheduleJob(spec({ sessionId: 'other-session' }), { dryRun: true, env });
  scheduleJob(spec({ sessionId: null, mode: 'create' }), { dryRun: true, env });
  scheduleJob(spec({ sessionId: null, mode: 'create' }), { dryRun: true, env });
});

test('scheduleJob allows rescheduling once the previous job finished', async () => {
  const env = makeEnv();
  const first = saveJob(scheduleJob(spec(), { dryRun: true, env }), env);
  await runJob(first.id, env);
  scheduleJob(spec(), { dryRun: true, env });
});

test('waitJob honors a cancellation that happens while waiting', async () => {
  const env = { ...makeEnv(), CODEWAKE_POLL_MS: '25' };
  const job = saveJob(scheduleJob(spec({ runAt: new Date(Date.now() + 500) }), { dryRun: true, env }), env);
  const waiting = waitJob(job.id, env);
  await new Promise((resolve) => setTimeout(resolve, 60));
  cancelJob(job.id, env);
  const result = await waiting;
  assert.equal(result.status, 'cancelled');
  assert.ok(!existsSync(logFile(job.id, env)), 'the agent never ran');
});

test('waitJob does not fire early for delays beyond the setTimeout clamp', async () => {
  // A single setTimeout above 2^31-1 ms fires after 1ms; the polling loop must not.
  const env = { ...makeEnv(), CODEWAKE_POLL_MS: '25' };
  const runAt = new Date(Date.now() + 2 ** 31 + 3600_000);
  const job = saveJob(scheduleJob(spec({ runAt }), { dryRun: true, env }), env);
  const waiting = waitJob(job.id, env);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(loadJob(job.id, env).status, 'pending', 'job did not fire early');
  cancelJob(job.id, env);
  assert.equal((await waiting).status, 'cancelled');
});

test('cancelJob does not signal the recorded pid of an overdue job', () => {
  // After a reboot the OS may have handed that pid to an unrelated process.
  const env = makeEnv();
  const job = saveJob({
    ...scheduleJob(spec({ runAt: new Date(Date.now() + 3600_000) }), { dryRun: true, env }),
    runAt: new Date(Date.now() - 3600_000).toISOString(),
    pid: process.pid, // if cancelJob signalled it, this test process would die
  }, env);
  const { job: cancelled } = cancelJob(job.id, env);
  assert.equal(cancelled.status, 'cancelled');
});

test('systemdCalendarSpec formats local wall-clock time with a small floor', () => {
  const now = Date.parse('2026-07-16T10:00:00');
  assert.equal(systemdCalendarSpec(Date.parse('2026-07-16T14:30:05'), now), '2026-07-16 14:30:05');
  // Past or immediate timestamps are floored to now + 5s.
  assert.equal(systemdCalendarSpec(now - 1000, now), '2026-07-16 10:00:05');
});

test('spawn backend arms a detached waiter that launches the job', async () => {
  const env = makeEnv();
  const job = scheduleJob(spec({ runAt: new Date(Date.now() + 200) }), { env });
  assert.equal(job.backend, 'spawn');
  assert.ok(job.pid > 0);
  const deadline = Date.now() + 8000;
  let current = loadJob(job.id, env);
  while (current.status !== 'done' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    current = loadJob(job.id, env);
  }
  assert.equal(current.status, 'done');
  assert.match(readFileSync(logFile(job.id, env), 'utf8'), /agent ran/);
});

test('clearJobs removes finished jobs but keeps pending ones', async () => {
  const env = makeEnv();
  const done = saveJob(scheduleJob(spec(), { dryRun: true, env }), env);
  await runJob(done.id, env);
  const pending = saveJob(scheduleJob(spec(), { dryRun: true, env }), env);
  const removed = clearJobs(env);
  assert.deepEqual(removed.map((job) => job.id), [done.id]);
  assert.deepEqual(listJobs(env).map((job) => job.id), [pending.id]);
});

test('displayStatus flags pending jobs whose launch time passed', () => {
  const now = Date.now();
  const fresh = { status: 'pending', runAt: new Date(now + 60000).toISOString() };
  const stale = { status: 'pending', runAt: new Date(now - 3600_000).toISOString() };
  assert.equal(displayStatus(fresh, now), 'pending');
  assert.equal(displayStatus(stale, now), 'overdue');
  assert.equal(displayStatus({ status: 'done', runAt: stale.runAt }, now), 'done');
});

test('job ids are validated before touching the filesystem', () => {
  const env = makeEnv();
  assert.throws(() => loadJob('../escape', env), /valid job id/);
});

// --- systemd backend (exercised through fake systemd-run/systemctl on PATH) ---

function makeFakeSystemd({ systemdRunExit = 0, systemctlExit = 0, systemctlScript = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-systemd-'));
  const capture = join(dir, 'systemd-run.args');
  writeFileSync(join(dir, 'systemd-run'), [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${capture}"`,
    systemdRunExit === 0 ? 'exit 0' : `echo "boom" >&2\nexit ${systemdRunExit}`,
  ].join('\n'));
  chmodSync(join(dir, 'systemd-run'), 0o755);
  const stopLog = join(dir, 'systemctl.calls');
  writeFileSync(join(dir, 'systemctl'), systemctlScript ?? [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${stopLog}"`,
    `exit ${systemctlExit}`,
  ].join('\n'));
  chmodSync(join(dir, 'systemctl'), 0o755);
  return { dir, capture, stopLog };
}

function withPath(dir, fn) {
  const original = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${original}`;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

test('systemd backend arms an on-calendar transient timer', { skip: onWindows }, () => {
  const env = { ...makeEnv(), CODEWAKE_BACKEND: 'systemd' };
  const fake = makeFakeSystemd();
  const job = withPath(fake.dir, () =>
    scheduleJob(spec({ runAt: new Date(Date.now() + 3600_000) }), { env }));
  assert.equal(job.backend, 'systemd');
  assert.equal(loadJob(job.id, env).status, 'pending');
  const args = readFileSync(fake.capture, 'utf8').split('\n');
  assert.ok(args.includes(`--unit=codewake-${job.id}`));
  assert.ok(args.some((arg) => /^--on-calendar=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(arg)));
  // The transient unit does not inherit the scheduler's environment.
  assert.ok(args.includes(`--setenv=CODEWAKE_STATE_DIR=${env.CODEWAKE_STATE_DIR}`));
  assert.ok(args.includes('--run'));
  assert.ok(args.includes(job.id));
});

test('systemd backend rolls the job back when systemd-run fails', { skip: onWindows }, () => {
  const env = { ...makeEnv(), CODEWAKE_BACKEND: 'systemd' };
  const fake = makeFakeSystemd({ systemdRunExit: 1 });
  assert.throws(
    () => withPath(fake.dir, () => scheduleJob(spec(), { env })),
    /boom/,
  );
  assert.deepEqual(listJobs(env), []);
});

test('systemd cancel stops the timer and the service', { skip: onWindows }, () => {
  const env = { ...makeEnv(), CODEWAKE_BACKEND: 'systemd' };
  const fake = makeFakeSystemd();
  const job = withPath(fake.dir, () =>
    scheduleJob(spec({ runAt: new Date(Date.now() + 3600_000) }), { env }));
  const { job: cancelled, warning } = withPath(fake.dir, () => cancelJob(job.id, env));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(warning, null);
  const calls = readFileSync(fake.stopLog, 'utf8');
  assert.match(calls, new RegExp(`stop codewake-${job.id}\\.timer`));
  assert.match(calls, new RegExp(`stop codewake-${job.id}\\.service`));
});

test('systemd cancel warns when the timer cannot be confirmed stopped', { skip: onWindows }, () => {
  const env = { ...makeEnv(), CODEWAKE_BACKEND: 'systemd' };
  const fake = makeFakeSystemd();
  const job = withPath(fake.dir, () =>
    scheduleJob(spec({ runAt: new Date(Date.now() + 3600_000) }), { env }));
  const failing = makeFakeSystemd({ systemctlExit: 1 });
  const { warning } = withPath(failing.dir, () => cancelJob(job.id, env));
  assert.match(warning, /Could not confirm/);
});

test('cancelJob refuses to clobber a job that started meanwhile', { skip: onWindows }, () => {
  // The fake systemctl flips the job to "running" mid-cancel, simulating the
  // timer firing at the exact moment of cancellation.
  const env = { ...makeEnv(), CODEWAKE_BACKEND: 'systemd' };
  const fake = makeFakeSystemd();
  const job = withPath(fake.dir, () =>
    scheduleJob(spec({ runAt: new Date(Date.now() + 3600_000) }), { env }));
  const jobPath = join(env.CODEWAKE_STATE_DIR, `${job.id}.json`);
  const running = JSON.stringify({ ...job, status: 'running' });
  const racing = makeFakeSystemd({
    systemctlScript: [
      '#!/bin/sh',
      `cat > "${jobPath}" <<'JSON'`,
      running,
      'JSON',
      'exit 0',
    ].join('\n'),
  });
  assert.throws(
    () => withPath(racing.dir, () => cancelJob(job.id, env)),
    /already running; too late to cancel/,
  );
  assert.equal(loadJob(job.id, env).status, 'running', 'the live state was not clobbered');
});
