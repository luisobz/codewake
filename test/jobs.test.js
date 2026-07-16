import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  waitJob,
} from '../lib/jobs.js';

const claude = { id: 'claude', name: 'Claude Code' };

function makeEnv() {
  return {
    AGENT_RESUME_STATE_DIR: mkdtempSync(join(tmpdir(), 'agent-resume-state-')),
    AGENT_RESUME_BACKEND: 'spawn',
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

test('runJob survives a missing executable', async () => {
  const env = makeEnv();
  const job = saveJob(scheduleJob(spec({ bin: '/nonexistent/agent' }), { dryRun: true, env }), env);
  const finished = await runJob(job.id, env);
  assert.equal(finished.status, 'failed');
  assert.ok(finished.error);
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
  const cancelled = cancelJob(job.id, env);
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => cancelJob(job.id, env), /only pending jobs/);
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
