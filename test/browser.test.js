import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { browseJobs, renderJobsTable } from '../lib/browser.js';
import { cancelJob, listJobs, saveJob, scheduleJob } from '../lib/jobs.js';

const onWindows = process.platform === 'win32';

function makeIo() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  let rendered = '';
  stdout.on('data', (chunk) => {
    rendered += chunk;
  });
  return { stdin, stdout, output: () => rendered };
}

/** Feed keystrokes one macrotask apart so each prompt is armed in between. */
async function type(stdin, keys) {
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    stdin.write(key);
  }
}

/** Poll until the rendered output satisfies `predicate` (async flows). */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'codewake-browser-home-'));
  return {
    HOME: home,
    PATH: '/nonexistent-path',
    CODEWAKE_STATE_DIR: mkdtempSync(join(tmpdir(), 'codewake-browser-state-')),
    CODEWAKE_BACKEND: 'spawn',
    CODEWAKE_CONFIG: join(home, 'missing-config.json'),
  };
}

let fixtureCounter = 0;

function fixtureJob(env, overrides = {}) {
  fixtureCounter += 1;
  const job = scheduleJob({
    agent: { id: 'claude', name: 'Claude Code' },
    bin: process.execPath,
    args: ['-e', 'console.log("ran")'],
    mode: 'resume',
    sessionId: `sess-${fixtureCounter}`,
    prompt: 'continue',
    skipPermissions: false,
    project: process.cwd(),
    runAt: new Date(Date.now() + 3600_000),
  }, { dryRun: true, env });
  return saveJob({ ...job, ...overrides }, env);
}

test('renderJobsTable marks the selected row with a pointer', () => {
  const now = Date.now();
  const jobs = [
    { id: 'job-1', agentName: 'Claude Code', status: 'failed', runAt: new Date(now).toISOString(), mode: 'resume', sessionId: 'aaa', project: '/w' },
    { id: 'job-2', agentName: 'Goose', status: 'done', runAt: new Date(now).toISOString(), mode: 'resume', sessionId: 'bbb', project: '/w' },
  ];
  const lines = renderJobsTable(jobs, now, { width: 120, selected: 1 }).split('\n');
  assert.ok(!lines[1].includes('❯'), 'unselected row has no pointer');
  assert.ok(lines[2].includes('❯'), 'selected row is pointed at');
});

test('browser lists jobs and returns to the menu on q', async () => {
  const env = makeEnv();
  fixtureJob(env, { status: 'failed' });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['q']);
  assert.equal(await result, 'menu');
  assert.match(io.output(), /Waked agents/);
  assert.match(io.output(), /1\/1 job/);
  assert.match(io.output(), /r retry · x cancel/);
});

test('browser search narrows the list and esc clears it', async () => {
  const env = makeEnv();
  fixtureJob(env, { sessionId: 'alpha-session' });
  fixtureJob(env, { sessionId: 'beta-session' });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['/', 'b', 'e', 't', 'a', '\r', 'q']);
  assert.equal(await result, 'menu');
  assert.match(io.output(), /search: "beta"/);
  assert.match(io.output(), /1\/2 jobs/);
  for (const job of listJobs(env)) cancelJob(job.id, env);
});

test('browser agent filter cycles through the agents present', async () => {
  const env = makeEnv();
  // Explicit createdAt keeps the list order (newest first) deterministic.
  fixtureJob(env, { status: 'failed', createdAt: new Date().toISOString() });
  fixtureJob(env, {
    status: 'done',
    agentId: 'codex',
    agentName: 'OpenAI Codex CLI',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['f', 'q']);
  assert.equal(await result, 'menu');
  assert.match(io.output(), /agent: Claude Code/);
  assert.match(io.output(), /1\/2 jobs/);
});

test('browser exits the whole console on a double ctrl+c', async () => {
  const env = makeEnv();
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['\x03', '\x03']);
  assert.equal(await result, 'exit');
  assert.match(io.output(), /Press ctrl\+c again within 5s to exit/);
});

test('browser retries a finished job asking for timing and prompt', async () => {
  const env = makeEnv();
  const failed = fixtureJob(env, { status: 'failed' });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, [
    'r', // retry the selected job
    '\x1b[B\r', // when: After a delay
    '3h\n',
    'fix the tests\n', // new prompt
  ]);
  await waitFor(() => /Rescheduled as/.test(io.output()));
  io.stdin.write('q');
  assert.equal(await result, 'menu');
  const jobs = listJobs(env);
  assert.equal(jobs.length, 2);
  const fresh = jobs.find((job) => job.id !== failed.id);
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.prompt, 'fix the tests');
  assert.deepEqual(fresh.args.slice(-2), ['-p', 'fix the tests']);
  cancelJob(fresh.id, env);
});

test('browser refuses to retry a job that is still pending', async () => {
  const env = makeEnv();
  const pending = fixtureJob(env);
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['r']);
  await waitFor(() => /only finished or overdue jobs/.test(io.output()));
  io.stdin.write('q');
  assert.equal(await result, 'menu');
  assert.equal(listJobs(env).length, 1);
  cancelJob(pending.id, env);
});

test('browser opens the selected job in its agent CLI', async () => {
  const env = makeEnv();
  const binDir = mkdtempSync(join(tmpdir(), 'codewake-browser-bin-'));
  const capture = join(binDir, 'open.args');
  if (onWindows) {
    writeFileSync(join(binDir, 'claude.cmd'), `@echo off\r\necho %* > "${capture}"\r\n`);
  } else {
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`);
    chmodSync(join(binDir, 'claude'), 0o755);
  }
  env.PATH = binDir;
  fixtureJob(env, { status: 'done', sessionId: 'sess-open-1' });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['\r']); // enter = open
  await waitFor(() => /closed \(exit 0\)/.test(io.output()));
  io.stdin.write('q');
  assert.equal(await result, 'menu');
  assert.match(io.output(), /Opening Claude Code/);
  const args = readFileSync(capture, 'utf8');
  assert.match(args, /--resume/);
  assert.match(args, /sess-open-1/);
});

test('browser opens with skip-permissions on S', async () => {
  const env = makeEnv();
  const binDir = mkdtempSync(join(tmpdir(), 'codewake-browser-bin-'));
  const capture = join(binDir, 'open.args');
  if (onWindows) {
    writeFileSync(join(binDir, 'claude.cmd'), `@echo off\r\necho %* > "${capture}"\r\n`);
  } else {
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`);
    chmodSync(join(binDir, 'claude'), 0o755);
  }
  env.PATH = binDir;
  fixtureJob(env, { status: 'done', sessionId: 'sess-open-skip' });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['S']); // S = open skipping permission prompts
  await waitFor(() => /closed \(exit 0\)/.test(io.output()));
  io.stdin.write('q');
  assert.equal(await result, 'menu');
  const args = readFileSync(capture, 'utf8');
  assert.match(args, /sess-open-skip/);
  assert.match(args, /--dangerously-skip-permissions/);
});

test('browser explains why a fresh-session job cannot be opened', async () => {
  const env = makeEnv();
  fixtureJob(env, { status: 'done', mode: 'create', sessionId: null });
  const io = makeIo();
  const result = browseJobs({ io, env });
  await type(io.stdin, ['\r']);
  await waitFor(() => /no session id to reopen/.test(io.output()));
  io.stdin.write('q');
  assert.equal(await result, 'menu');
});
