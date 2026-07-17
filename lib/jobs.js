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
import { loadAgents, which } from './agents.js';
import { spawnAgent } from './proc.js';
import { resolveSessionPlacement } from './sessions.js';

const CLI_BIN = fileURLToPath(new URL('../bin/codewake.js', import.meta.url));
const OVERDUE_GRACE_MS = 60_000;
const DEFAULT_POLL_MS = 60_000;

/** Job state directory, per platform convention. */
export function stateDir(env = process.env) {
  if (env.CODEWAKE_STATE_DIR) return resolve(env.CODEWAKE_STATE_DIR);
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'codewake');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'codewake');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'codewake');
}

/** Where job execution logs go, per platform convention. */
export function logsDir(env = process.env) {
  if (env.CODEWAKE_STATE_DIR) return join(resolve(env.CODEWAKE_STATE_DIR), 'logs');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'codewake', 'Logs');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Logs', 'codewake');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'codewake', 'logs');
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
  return `codewake-${jobId}`;
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
  if (env.CODEWAKE_BACKEND === 'systemd' || env.CODEWAKE_BACKEND === 'spawn') {
    return env.CODEWAKE_BACKEND;
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
      `Cancel it first with "codewake cancel ${duplicate.id}".`,
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
    if (job.backend === 'systemd') armSystemdTimer(job, now, env);
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

function armSystemdTimer(job, now, env) {
  const result = spawnSync('systemd-run', [
    '--user',
    `--unit=${unitName(job.id)}`,
    `--on-calendar=${systemdCalendarSpec(Date.parse(job.runAt), now)}`,
    // Transient user timers default to a 1-minute accuracy window; short
    // delays ("--in 5s") would otherwise fire up to a minute late.
    '--timer-property=AccuracySec=1s',
    '--collect',
    '--quiet',
    // The unit does not inherit this process's environment: point it at the
    // same state (and config) that scheduled the job.
    `--setenv=CODEWAKE_STATE_DIR=${stateDir(env)}`,
    ...(env.CODEWAKE_CONFIG ? [`--setenv=CODEWAKE_CONFIG=${resolve(env.CODEWAKE_CONFIG)}`] : []),
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
    env: { ...process.env, CODEWAKE_STATE_DIR: stateDir(env) },
  });
  // Without a listener, an async spawn failure would crash the CLI later
  // with an unhandled 'error' event instead of surfacing as a message.
  child.on('error', (error) => {
    console.error(`codewake: could not start the waiter for job ${job.id}: ${error.message}`);
  });
  job.pid = child.pid;
  child.unref();
  saveJob(job, env);
}

/**
 * Re-check where a resume job must run right before launch: the project may
 * have been moved, renamed or deleted between scheduling and firing, and the
 * session's own store knows the directory it truly belongs to. Lookup is
 * best effort — when nothing better is known the scheduled project stands,
 * and the agent reports its own error if it cannot find the session.
 */
function placementForRun(job, env) {
  let placement = null;
  if (job.mode === 'resume' && job.sessionId) {
    try {
      const agent = loadAgents({ env }).find((candidate) => candidate.id === job.agentId);
      if (agent) {
        placement = resolveSessionPlacement(agent, job.sessionId, {
          project: job.project,
          home: env.HOME || homedir(),
        });
      }
    } catch {
      // A broken config or a session that vanished must not stop the launch.
    }
  }
  const project = placement?.project ?? job.project;
  if (!existsSync(project)) {
    return {
      error: `Project directory ${project} no longer exists (was it moved or renamed?). ` +
        `Reschedule with "codewake retry ${job.id} --project <dir>".`,
    };
  }
  return { project, note: placement?.note ?? null };
}

/** Launch the agent for a job right now. Resolves when the agent exits. */
export function runJob(jobId, env = process.env) {
  const job = loadJob(jobId, env);
  if (job.status === 'cancelled') return Promise.resolve(job);
  const placement = placementForRun(job, env);
  if (placement.project) job.project = placement.project;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.log = logFile(job.id, env);
  saveJob(job, env);
  ensureDir(logsDir(env));
  const log = createWriteStream(job.log, { mode: 0o600 });
  if (placement.note) log.write(`codewake: ${placement.note}\n`);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      // Failures land in the log too, so "codewake logs" always explains.
      if (patch.error) log.write(`codewake: ${patch.error}\n`);
      Object.assign(job, patch, { finishedAt: new Date().toISOString() });
      saveJob(job, env);
      // Resolve only once the log is flushed to disk, so a "codewake logs"
      // right after completion never reads a partial (or missing) file.
      log.end(() => resolvePromise(job));
    };
    if (placement.error) {
      finish({ status: 'failed', error: placement.error });
      return;
    }
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
    // 'close' (not 'exit') guarantees stdout/stderr finished piping first.
    child.on('close', (code, signal) => finish({
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
  const pollMs = Number(env.CODEWAKE_POLL_MS) > 0
    ? Number(env.CODEWAKE_POLL_MS)
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
