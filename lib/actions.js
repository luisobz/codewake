import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { buildCommand, commandPreview, detectAgents, loadAgents } from './agents.js';
import { cancelJob, displayStatus, loadJob, scheduleJob } from './jobs.js';
import { spawnAgent } from './proc.js';
import { resolveSessionPlacement } from './sessions.js';
import { describeRunAt, parseClockTime, parseDuration } from './time.js';

export const DEFAULT_RESUME_PROMPT = 'continue';

/** Turn a when-descriptor ({type: now|in|at}) or a Date into a launch Date. */
export function resolveRunAt(when, now = new Date()) {
  if (when instanceof Date) return when;
  if (when.type === 'in') return new Date(now.getTime() + parseDuration(when.value) * 1000);
  if (when.type === 'at') return parseClockTime(when.value, now);
  return now;
}

/**
 * Validate and schedule a job from a spec: { agentId, sessionId, isNew,
 * prompt, skipPermissions, project, when, bin, fallbackBin, dryRun }.
 * Returns { job, preview, note }; `note` explains a corrected project.
 */
export function scheduleFromSpec(args, env = process.env) {
  const detected = detectAgents(loadAgents({ env }), { env });
  const entry = detected.find((candidate) => candidate.agent.id === args.agentId);
  if (!entry) {
    const known = detected.map((candidate) => candidate.agent.id).join(', ');
    throw new Error(`Unknown agent "${args.agentId}". Known agents: ${known}.`);
  }
  const bin = args.bin ?? entry.bin ?? args.fallbackBin ?? null;
  if (!bin) {
    throw new Error(`${entry.agent.name} is not installed (looked for: ${entry.agent.bins.join(', ')}). Use --bin to point at it.`);
  }
  const mode = args.isNew ? 'create' : 'resume';
  const prompt = args.prompt?.trim() || DEFAULT_RESUME_PROMPT;
  let project = args.project;
  let note = null;
  if (mode === 'resume') {
    const placement = resolveSessionPlacement(entry.agent, args.sessionId, {
      project,
      home: env.HOME || homedir(),
    });
    project = placement.project;
    note = placement.note;
  }
  const commandArgs = buildCommand(entry.agent, {
    mode,
    sessionId: args.sessionId,
    prompt,
    skipPermissions: args.skipPermissions,
  });
  const job = scheduleJob({
    agent: entry.agent,
    bin,
    args: commandArgs,
    mode,
    sessionId: args.sessionId,
    prompt,
    skipPermissions: args.skipPermissions,
    project,
    runAt: resolveRunAt(args.when),
  }, { dryRun: args.dryRun, env });
  return { job, preview: commandPreview(bin, commandArgs), note };
}

/**
 * Re-schedule an existing job through the normal validation path, so the
 * session is located again and a moved project is corrected instead of
 * reproducing the original failure. `args`: { jobId, when, prompt, project,
 * dryRun } — prompt/project default to the previous job's values.
 */
export function retryFromSpec(args, env = process.env) {
  const previous = loadJob(args.jobId, env);
  if (previous.status === 'running') {
    throw new Error(`Job ${args.jobId} is still running; nothing to retry.`);
  }
  if (previous.status === 'pending') {
    if (displayStatus(previous) !== 'overdue') {
      throw new Error(
        `Job ${args.jobId} is still pending (launching ${describeRunAt(previous.runAt)}). ` +
        `Cancel it first: codewake cancel ${args.jobId}.`,
      );
    }
    // Its launch window silently passed (reboot, killed waiter): disarm the
    // stale schedule before arming a fresh one.
    cancelJob(args.jobId, env);
  }
  return scheduleFromSpec({
    agentId: previous.agentId,
    sessionId: previous.sessionId,
    isNew: previous.mode === 'create',
    prompt: args.prompt ?? previous.prompt,
    skipPermissions: previous.skipPermissions,
    project: args.project ?? previous.project,
    when: args.when,
    // The bin the job was created with wins (it may have been a --bin
    // override); if it disappeared, fall back to fresh detection.
    bin: existsSync(previous.bin) ? previous.bin : null,
    fallbackBin: previous.bin,
    dryRun: args.dryRun,
  }, env);
}

/**
 * Work out how to reopen a job's session in its agent's own interactive
 * terminal UI. Returns { agent, bin, args, project, note, preview }.
 * Throws with a human explanation when the job cannot be opened.
 */
export function prepareOpen(job, env = process.env) {
  if (!job.sessionId) {
    throw new Error(`Job ${job.id} started a fresh session; there is no session id to reopen.`);
  }
  const detected = detectAgents(loadAgents({ env }), { env });
  const entry = detected.find((candidate) => candidate.agent.id === job.agentId);
  if (!entry) {
    throw new Error(`Agent "${job.agentId}" is not configured anymore (check your codewake config).`);
  }
  const bin = entry.bin ?? (existsSync(job.bin) ? job.bin : null);
  if (!bin) {
    throw new Error(`${entry.agent.name} is not installed anymore (looked for: ${entry.agent.bins.join(', ')}).`);
  }
  const args = buildCommand(entry.agent, { mode: 'open', sessionId: job.sessionId });
  // Same relocation as launches: the agent only finds the session from the
  // project it belongs to, and the directory may have moved since.
  let placement = null;
  try {
    placement = resolveSessionPlacement(entry.agent, job.sessionId, {
      project: job.project,
      home: env.HOME || homedir(),
    });
  } catch {
    // Best effort: open from the recorded project and let the agent decide.
  }
  const project = placement?.project ?? job.project;
  if (!existsSync(project)) {
    throw new Error(`Project directory ${project} no longer exists (was it moved or renamed?).`);
  }
  return {
    agent: entry.agent,
    bin,
    args,
    project,
    note: placement?.note ?? null,
    preview: commandPreview(bin, args),
  };
}

/**
 * Hand the terminal over to the agent for a prepared open. Resolves with
 * the agent's exit code once the user leaves it.
 */
export function attachOpen(prepared, { stdio = 'inherit' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnAgent(prepared.bin, prepared.args, { cwd: prepared.project, stdio });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    child.on('error', rejectPromise);
    child.on('exit', (code) => resolvePromise(code ?? 0));
  });
}
