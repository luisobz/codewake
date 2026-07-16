import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runWizard } from '../lib/wizard.js';
import { listJobs, loadJob } from '../lib/jobs.js';
import { encodeClaudeProject } from '../lib/sessions.js';

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

function makeEnv({ withClaude = true } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'agent-resume-wiz-bin-'));
  if (withClaude) {
    const bin = join(binDir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
  }
  const home = mkdtempSync(join(tmpdir(), 'agent-resume-wiz-home-'));
  return {
    PATH: binDir,
    HOME: home,
    AGENT_RESUME_STATE_DIR: mkdtempSync(join(tmpdir(), 'agent-resume-wiz-state-')),
    AGENT_RESUME_BACKEND: 'spawn',
    AGENT_RESUME_CONFIG: join(home, 'missing-config.json'),
  };
}

/** Feed keystrokes one macrotask apart so each prompt is armed in between. */
async function type(stdin, keys) {
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    stdin.write(key);
  }
}

test('wizard exits from the main menu', async () => {
  const io = makeIo();
  const done = runWizard({ io, env: makeEnv() });
  await type(io.stdin, ['\x1b[B\x1b[B\x1b[B\x1b[B', '\r']); // move to Exit, enter
  await done;
  assert.match(io.output(), /What do you want to do\?/);
  assert.match(io.output(), /Bye!/);
});

test('wizard explains when no agents are installed', async () => {
  const io = makeIo();
  const done = runWizard({ io, env: makeEnv({ withClaude: false }) });
  await type(io.stdin, ['\r', 'q']); // Schedule → back at menu → quit
  await done;
  assert.match(io.output(), /No supported agents found/);
});

test('wizard schedules a resume job end to end', async () => {
  const env = makeEnv();
  // One existing Claude session for the current project.
  const projectDir = join(env.HOME, '.claude', 'projects', encodeClaudeProject(process.cwd()));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, '550e8400-e29b-41d4-a716-446655440000.jsonl'),
    `${JSON.stringify({ type: 'summary', summary: 'Ship the new API' })}\n`,
  );

  const io = makeIo();
  const done = runWizard({ io, env });
  await type(io.stdin, [
    '\r', // menu: Schedule a resume job
    '\r', // agent: Claude Code (only one installed)
    '\r', // session: the existing one
    '\n', // prompt: accept default "continue"
    'y\n', // skip permissions: yes
    '\x1b[B\r', // when: After a delay
    '45m\n', // delay value
    'y\n', // confirm summary
    'q', // back at menu: quit
  ]);
  await done;

  const jobs = listJobs(env);
  assert.equal(jobs.length, 1);
  const job = loadJob(jobs[0].id, env);
  assert.equal(job.agentId, 'claude');
  assert.equal(job.mode, 'resume');
  assert.equal(job.sessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(job.prompt, 'continue');
  assert.equal(job.skipPermissions, true);
  assert.deepEqual(job.args, [
    '--resume',
    '550e8400-e29b-41d4-a716-446655440000',
    '-p',
    'continue',
    '--dangerously-skip-permissions',
  ]);
  const delayMs = Date.parse(job.runAt) - Date.parse(job.createdAt);
  assert.ok(Math.abs(delayMs - 45 * 60 * 1000) < 5000, `runAt is ~45m out (got ${delayMs}ms)`);
  assert.match(io.output(), /Ship the new API/);
  assert.match(io.output(), /Job .* scheduled/);

  // The job is pending; cancel it so no stray waiter fires later.
  const { cancelJob } = await import('../lib/jobs.js');
  cancelJob(job.id, env);
});

test('wizard requires a prompt for new sessions', async () => {
  const env = makeEnv();
  const io = makeIo();
  const done = runWizard({ io, env });
  await type(io.stdin, [
    '\r', // Schedule
    '\r', // Claude Code
    '\x1b[B\r', // "Start a new session" (after "Enter a session id manually")
    '\n', // empty prompt → re-asked
    'build the landing page\n',
    '\n', // skip permissions: default no
    '\r', // when: Right now
    'y\n', // confirm
    'q',
  ]);
  await done;
  assert.match(io.output(), /This field is required/);
  const jobs = listJobs(env);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, 'create');
  assert.equal(jobs[0].prompt, 'build the landing page');
  assert.equal(jobs[0].skipPermissions, false);
});

test('wizard lists and cancels jobs from the menu', async () => {
  const env = makeEnv();
  const io = makeIo();
  const done = runWizard({ io, env });
  await type(io.stdin, [
    '\r', // Schedule
    '\r', // Claude Code
    '\r', // no sessions → "Enter a session id manually" is first
    'manual-session-1\n',
    '\n', // default prompt
    '\n', // permissions default no
    '\x1b[B\r', // After a delay
    '2h\n',
    'y\n', // confirm
    '\x1b[B\r', // menu: View jobs
    '\x1b[B\x1b[B\r', // menu: Cancel a job
    '\r', // pick the only job
    '\n', // confirm cancel (default yes)
    'q', // quit
  ]);
  await done;
  assert.match(io.output(), /ID\s+AGENT\s+STATUS/);
  assert.match(io.output(), /manual-sessi/);
  const jobs = listJobs(env);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'cancelled');
});
