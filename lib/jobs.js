import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './agents.js';

const CLI_BIN = fileURLToPath(new URL('../bin/agent-resume.js', import.meta.url));
const OVERDUE_GRACE_MS = 60_000;

export function stateDir(env = process.env) {
  return env.AGENT_RESUME_STATE_DIR || resolve(homedir(), '.local', 'state', 'agent-resume');
}

function assertJobId(jobId) {
  if (!jobId || !/^[a-z0-9-]+$/i.test(jobId)) throw new Error('Provide a valid job id.');
  return jobId;
}

export function jobFile(jobId, env = process.env) {
  return join(stateDir(env), `${assertJobId(jobId)}.json`);
}

export function logFile(jobId, env = process.env) {
  return join(stateDir(env), `${assertJobId(jobId)}.log`);
}

function unitName(jobId) {
  return `agent-resume-${jobId}`;
}

export function makeJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function saveJob(job, env = process.env) {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(jobFile(job.id, env), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  return job;
}

export function loadJob(jobId, env = process.env) {
  const path = jobFile(jobId, env);
  if (!existsSync(path)) throw new Error(`Job ${jobId} does not exist.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function listJobs(env = process.env) {
  const dir = stateDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Remove finished jobs (done/failed/cancelled) and their logs. */
export function clearJobs(env = process.env) {
  const removed = [];
  for (const job of listJobs(env)) {
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      rmSync(jobFile(job.id, env), { force: true });
      rmSync(logFile(job.id, env), { force: true });
      removed.push(job);
    }
  }
  return removed;
}

export function pickBackend(env = process.env) {
  if (env.AGENT_RESUME_BACKEND === 'systemd' || env.AGENT_RESUME_BACKEND === 'spawn') {
    return env.AGENT_RESUME_BACKEND;
  }
  return process.platform === 'linux' && which('systemd-run', env) ? 'systemd' : 'spawn';
}

/**
 * Persist and arm a job. `spec` carries agent/bin/args/mode/sessionId/
 * prompt/skipPermissions/project/runAt. With `dryRun` nothing is written.
 */
export function scheduleJob(spec, { dryRun = false, env = process.env } = {}) {
  const now = Date.now();
  const runAt = spec.runAt instanceof Date ? spec.runAt : new Date(spec.runAt ?? now);
  if (!existsSync(spec.project)) throw new Error(`Project directory does not exist: ${spec.project}`);
  const job = {
    id: makeJobId(),
    agentId: spec.agent.id,
    agentName: spec.agent.name,
    bin: spec.bin,
    args: spec.args,
    mode: spec.mode,
    sessionId: spec.sessionId ?? null,
    prompt: spec.prompt,
    skipPermissions: Boolean(spec.skipPermissions),
    project: spec.project,
    createdAt: new Date(now).toISOString(),
    runAt: runAt.toISOString(),
    backend: pickBackend(env),
    status: 'pending',
  };
  if (dryRun) return job;
  saveJob(job, env);
  try {
    if (job.backend === 'systemd') armSystemdTimer(job, now);
    else armDetachedWaiter(job, env);
  } catch (error) {
    rmSync(jobFile(job.id, env), { force: true });
    throw error;
  }
  return job;
}

function armSystemdTimer(job, now) {
  const delaySeconds = Math.max(1, Math.ceil((Date.parse(job.runAt) - now) / 1000));
  const result = spawnSync('systemd-run', [
    '--user',
    `--unit=${unitName(job.id)}`,
    `--on-active=${delaySeconds}s`,
    '--collect',
    '--quiet',
    process.execPath,
    CLI_BIN,
    '--run',
    job.id,
  ], { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not run systemd-run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'systemd-run failed.').trim());
  }
}

function armDetachedWaiter(job, env) {
  const child = spawn(process.execPath, [CLI_BIN, '--wait', job.id], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_RESUME_STATE_DIR: stateDir(env) },
  });
  job.pid = child.pid;
  child.unref();
  saveJob(job, env);
}

/** Launch the agent for a job right now. Resolves when the agent exits. */
export function runJob(jobId, env = process.env) {
  const job = loadJob(jobId, env);
  if (job.status === 'cancelled') return Promise.resolve(job);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  saveJob(job, env);
  const log = createWriteStream(logFile(job.id, env), { mode: 0o600 });
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      Object.assign(job, patch, { finishedAt: new Date().toISOString() });
      saveJob(job, env);
      log.end();
      resolvePromise(job);
    };
    let child;
    try {
      child = spawn(job.bin, job.args, { cwd: job.project, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ status: 'failed', error: error.message });
      return;
    }
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', (error) => finish({ status: 'failed', error: error.message }));
    child.on('exit', (code, signal) => finish({
      status: code === 0 ? 'done' : 'failed',
      exitCode: code,
      signal: signal ?? undefined,
    }));
  });
}

/** Sleep until the job is due, then run it (used by the spawn backend). */
export async function waitJob(jobId, env = process.env) {
  const job = loadJob(jobId, env);
  const remaining = Date.parse(job.runAt) - Date.now();
  if (remaining > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, remaining));
  let fresh;
  try {
    fresh = loadJob(jobId, env);
  } catch {
    return null;
  }
  if (fresh.status !== 'pending') return fresh;
  return runJob(jobId, env);
}

export function cancelJob(jobId, env = process.env) {
  const job = loadJob(jobId, env);
  if (job.status !== 'pending') {
    throw new Error(`Job ${jobId} is ${job.status}; only pending jobs can be cancelled.`);
  }
  if (job.backend === 'systemd') {
    // Best effort: the transient timer may already be gone (e.g. after reboot).
    spawnSync('systemctl', ['--user', 'stop', `${unitName(job.id)}.timer`], { encoding: 'utf8' });
  } else if (job.pid) {
    try {
      process.kill(job.pid);
    } catch {
      // Waiter already gone.
    }
  }
  job.status = 'cancelled';
  job.cancelledAt = new Date().toISOString();
  saveJob(job, env);
  return job;
}

/** Human status; flags pending jobs whose launch time silently passed. */
export function displayStatus(job, now = Date.now()) {
  if (job.status === 'pending' && Date.parse(job.runAt) + OVERDUE_GRACE_MS < now) return 'overdue';
  return job.status;
}
