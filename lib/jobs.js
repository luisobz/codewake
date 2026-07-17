import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { spawnAgent } from './proc.js';

const CLI_BIN = fileURLToPath(new URL('../bin/agent-resume.js', import.meta.url));
const OVERDUE_GRACE_MS = 60_000;
const DEFAULT_POLL_MS = 60_000;

/** Job state directory, per platform convention. */
export function stateDir(env = process.env) {
  if (env.AGENT_RESUME_STATE_DIR) return resolve(env.AGENT_RESUME_STATE_DIR);
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'agent-resume');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'agent-resume');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'agent-resume');
}

/** Where job execution logs go, per platform convention. */
export function logsDir(env = process.env) {
  if (env.AGENT_RESUME_STATE_DIR) return join(resolve(env.AGENT_RESUME_STATE_DIR), 'logs');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'agent-resume', 'Logs');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Logs', 'agent-resume');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'agent-resume', 'logs');
}

function assertJobId(jobId) {
  if (!jobId || !/^[a-z0-9-]+$/i.test(jobId)) throw new Error('Provide a valid job id.');
  return jobId;
}

export function jobFile(jobId, env = process.env) {
  return join(stateDir(env), `${assertJobId(jobId)}.json`);
}

export function logFile(jobId, env = process.env) {
  return join(logsDir(env), `${assertJobId(jobId)}.log`);
}

function unitName(jobId) {
  return `agent-resume-${jobId}`;
}

export function makeJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // mkdirSync does not tighten a pre-existing directory.
    chmodSync(dir, 0o700);
  } catch {
    // Best effort (e.g. Windows).
  }
}

export function saveJob(job, env = process.env) {
  ensureDir(stateDir(env));
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

/** Pending job already scheduled for the same agent session, if any. */
export function findPendingForSession(agentId, sessionId, env = process.env) {
  if (!sessionId) return null;
  return listJobs(env).find(
    (job) => job.status === 'pending' && job.agentId === agentId && job.sessionId === sessionId,
  ) ?? null;
}

/**
 * Persist and arm a job. `spec` carries agent/bin/args/mode/sessionId/
 * prompt/skipPermissions/project/runAt. With `dryRun` nothing is written.
 */
export function scheduleJob(spec, { dryRun = false, env = process.env } = {}) {
  const now = Date.now();
  const runAt = spec.runAt instanceof Date ? spec.runAt : new Date(spec.runAt ?? now);
  if (!existsSync(spec.project)) throw new Error(`Project directory does not exist: ${spec.project}`);
  const duplicate = findPendingForSession(spec.agent.id, spec.sessionId ?? null, env);
  if (duplicate) {
    throw new Error(
      `Session ${spec.sessionId} already has a pending job (${duplicate.id}, launching ${new Date(duplicate.runAt).toLocaleString()}). ` +
      `Cancel it first with "agent-resume cancel ${duplicate.id}".`,
    );
  }
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

/** "YYYY-MM-DD HH:MM:SS" in local time, for systemd's OnCalendar. */
export function systemdCalendarSpec(runAtMs, now = Date.now()) {
  // Wall-clock timers keep ticking through suspend and fire on resume;
  // --on-active uses the monotonic clock, which pauses while suspended.
  const at = new Date(Math.max(runAtMs, now + 5000));
  const pad = (value) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function armSystemdTimer(job, now) {
  const result = spawnSync('systemd-run', [
    '--user',
    `--unit=${unitName(job.id)}`,
    `--on-calendar=${systemdCalendarSpec(Date.parse(job.runAt), now)}`,
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
  const child = spawnAgent(process.execPath, [CLI_BIN, '--wait', job.id], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_RESUME_STATE_DIR: stateDir(env) },
  });
  // Without a listener, an async spawn failure would crash the CLI later
  // with an unhandled 'error' event instead of surfacing as a message.
  child.on('error', (error) => {
    console.error(`agent-resume: could not start the waiter for job ${job.id}: ${error.message}`);
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
  job.log = logFile(job.id, env);
  saveJob(job, env);
  ensureDir(logsDir(env));
  const log = createWriteStream(job.log, { mode: 0o600 });
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
      child = spawnAgent(job.bin, job.args, { cwd: job.project, stdio: ['ignore', 'pipe', 'pipe'] });
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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Wait until the job is due, then run it (used by the spawn backend).
 *
 * Polls the wall clock in short slices instead of one long setTimeout:
 * a single timeout would drift by however long the machine was suspended
 * (Node timers pause during suspend) and silently overflows past ~24.8
 * days. Re-reading the job each slice also honors cancellation promptly.
 */
export async function waitJob(jobId, env = process.env) {
  const pollMs = Number(env.AGENT_RESUME_POLL_MS) > 0
    ? Number(env.AGENT_RESUME_POLL_MS)
    : DEFAULT_POLL_MS;
  for (;;) {
    let job;
    try {
      job = loadJob(jobId, env);
    } catch {
      return null;
    }
    if (job.status !== 'pending') return job;
    const remaining = Date.parse(job.runAt) - Date.now();
    if (remaining <= 0) return runJob(jobId, env);
    await sleep(Math.min(remaining, pollMs));
  }
}

/**
 * Cancel a pending job. Returns { job, warning }; `warning` is set when
 * the scheduled launch could not be confirmed as disarmed.
 */
export function cancelJob(jobId, env = process.env) {
  const job = loadJob(jobId, env);
  if (job.status !== 'pending') {
    throw new Error(`Job ${jobId} is ${job.status}; only pending jobs can be cancelled.`);
  }
  let warning = null;
  const overdue = displayStatus(job) === 'overdue';
  if (job.backend === 'systemd') {
    const stop = spawnSync('systemctl', ['--user', 'stop', `${unitName(job.id)}.timer`], { encoding: 'utf8' });
    // If the timer already elapsed, the transient service may be what's live.
    spawnSync('systemctl', ['--user', 'stop', `${unitName(job.id)}.service`], { encoding: 'utf8' });
    if (!overdue && (stop.error || stop.status !== 0)) {
      warning = 'Could not confirm the systemd timer was stopped; check "systemctl --user list-timers".';
    }
  } else if (job.pid && !overdue) {
    // Never signal an overdue job's recorded pid: after a reboot the OS may
    // have reassigned it to an unrelated process. The waiter re-checks the
    // job status on every poll and exits on its own when it sees the cancel.
    try {
      process.kill(job.pid);
    } catch {
      // Waiter already gone; the status check below still protects us.
    }
  }
  // Re-read before the final write: the waiter may have flipped the job to
  // running/done in the meantime, and a stale write would hide a live agent.
  const fresh = loadJob(jobId, env);
  if (fresh.status !== 'pending') {
    throw new Error(`Job ${jobId} is already ${fresh.status}; too late to cancel.`);
  }
  fresh.status = 'cancelled';
  fresh.cancelledAt = new Date().toISOString();
  saveJob(fresh, env);
  return { job: fresh, warning };
}

/** Human status; flags pending jobs whose launch time silently passed. */
export function displayStatus(job, now = Date.now()) {
  if (job.status === 'pending' && Date.parse(job.runAt) + OVERDUE_GRACE_MS < now) return 'overdue';
  return job.status;
}
