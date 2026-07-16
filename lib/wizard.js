import { homedir } from 'node:os';
import { buildCommand, commandPreview, configPath, detectAgents, loadAgents } from './agents.js';
import { cancelJob, clearJobs, displayStatus, listJobs, scheduleJob } from './jobs.js';
import { listSessions } from './sessions.js';
import { describeRunAt, parseClockTime, parseDuration, timeAgo } from './time.js';
import { color, confirm, input, select } from './tui.js';

const DEFAULT_RESUME_PROMPT = 'continue';

/** Interactive console. `io` lets tests inject stdin/stdout. */
export async function runWizard({ version = '', io = {}, env = process.env } = {}) {
  const out = io.stdout ?? process.stdout;
  out.write(`\n${color.bold('agent-resume')}${version ? color.dim(` v${version}`) : ''} ${color.dim('— schedule your coding agents to pick up where they left off')}\n\n`);
  for (;;) {
    const action = await select('What do you want to do?', [
      { label: 'Schedule a resume job', value: 'schedule', hint: 'pick agent → session → prompt → time' },
      { label: 'View jobs', value: 'jobs' },
      { label: 'Cancel a job', value: 'cancel' },
      { label: 'Clean up finished jobs', value: 'clear' },
      { label: 'Exit', value: 'exit' },
    ], io);
    if (!action || action === 'exit') {
      out.write(color.dim('Bye!\n'));
      return;
    }
    if (action === 'schedule') await scheduleFlow({ io, env, out });
    else if (action === 'jobs') viewJobs(out, env);
    else if (action === 'cancel') await cancelFlow({ io, env, out });
    else if (action === 'clear') {
      const removed = clearJobs(env);
      out.write(removed.length
        ? `${color.green('✔')} Removed ${removed.length} finished job${removed.length === 1 ? '' : 's'}.\n\n`
        : color.dim('Nothing to clean up.\n\n'));
    }
  }
}

async function scheduleFlow({ io, env, out }) {
  const detected = detectAgents(loadAgents({ env }), { env });
  const installed = detected.filter((entry) => entry.bin);
  if (!installed.length) {
    out.write(`${color.yellow('!')} No supported agents found on your PATH.\n`);
    out.write(color.dim(`  Known agents: ${detected.map((entry) => entry.agent.bins[0]).join(', ')}\n`));
    out.write(color.dim(`  Add your own in ${configPath(env)}\n\n`));
    return;
  }

  const picked = await select('Which agent do you want to launch?', installed.map((entry) => ({
    label: entry.agent.name,
    value: entry,
    hint: `(${entry.bin})`,
  })), io);
  if (!picked) return;
  const { agent, bin } = picked;

  // Session: existing, manual id, or brand new.
  let mode = 'create';
  let sessionId = null;
  if (agent.resume) {
    const sessions = listSessions(agent, { project: process.cwd(), home: env.HOME || homedir() });
    const choices = sessions.slice(0, 25).map((session) => ({
      label: session.title,
      value: { mode: 'resume', sessionId: session.id },
      hint: `${session.id.slice(0, 8)} · ${timeAgo(session.updatedAt)}`,
    }));
    choices.push({ label: 'Enter a session id manually', value: { mode: 'manual' } });
    if (agent.create) choices.push({ label: 'Start a new session', value: { mode: 'create' } });
    const chosen = await select(
      sessions.length ? `Which session do you want to resume?` : `No sessions found for ${agent.name} here — what now?`,
      choices,
      io,
    );
    if (!chosen) return;
    if (chosen.mode === 'manual') {
      const manual = await input('Session id', { required: true, ...io });
      if (manual === null) return;
      mode = 'resume';
      sessionId = manual;
    } else {
      mode = chosen.mode;
      sessionId = chosen.sessionId ?? null;
    }
  } else {
    out.write(color.dim(`  ${agent.name} only supports starting new sessions from here.\n`));
  }

  // Prompt: optional when resuming (defaults to "continue"), required for new sessions.
  const prompt = mode === 'resume'
    ? await input('Prompt to send', { def: DEFAULT_RESUME_PROMPT, ...io })
    : await input('Prompt for the new session', { required: true, ...io });
  if (prompt === null) return;

  // Permissions.
  const spec = mode === 'resume' ? agent.resume : agent.create;
  let skipPermissions = false;
  if (spec.skip) {
    const answer = await confirm('Skip permission prompts? (the agent will run fully unattended)', { def: false, ...io });
    if (answer === null) return;
    skipPermissions = answer;
  }

  // When to launch.
  const runAt = await askWhen(io);
  if (runAt === null) return;

  const args = buildCommand(agent, { mode, sessionId, prompt, skipPermissions });
  const project = process.cwd();

  out.write(`\n${color.bold('Summary')}\n`);
  out.write(`  ${color.dim('Agent')}        ${agent.name}\n`);
  out.write(`  ${color.dim('Session')}      ${mode === 'resume' ? sessionId : 'new session'}\n`);
  out.write(`  ${color.dim('Prompt')}       ${prompt}\n`);
  out.write(`  ${color.dim('Permissions')}  ${skipPermissions ? color.yellow('skipped (unattended)') : 'interactive'}\n`);
  out.write(`  ${color.dim('Launch')}       ${describeRunAt(runAt)}\n`);
  out.write(`  ${color.dim('Project')}      ${project}\n`);
  out.write(`  ${color.dim('Command')}      ${commandPreview(bin, args)}\n\n`);

  const go = await confirm('Schedule it?', { def: true, ...io });
  if (!go) {
    out.write(color.dim('Discarded.\n\n'));
    return;
  }
  const job = scheduleJob({ agent, bin, args, mode, sessionId, prompt, skipPermissions, project, runAt }, { env });
  out.write(`${color.green('✔')} Job ${color.bold(job.id)} scheduled ${describeRunAt(job.runAt)}.\n`);
  out.write(color.dim(`  Manage it with "agent-resume jobs", "agent-resume logs ${job.id}" or "agent-resume cancel ${job.id}".\n\n`));
}

async function askWhen(io) {
  const kind = await select('When should it launch?', [
    { label: 'Right now', value: 'now' },
    { label: 'After a delay', value: 'in', hint: 'e.g. 2h 30m' },
    { label: 'At a specific time', value: 'at', hint: 'e.g. 14:30' },
  ], io);
  if (!kind) return null;
  if (kind === 'now') return new Date();
  if (kind === 'in') {
    const text = await input('Delay', {
      required: true,
      validate: (value) => tryError(() => parseDuration(value)),
      ...io,
    });
    if (text === null) return null;
    return new Date(Date.now() + parseDuration(text) * 1000);
  }
  const text = await input('Time (24h)', {
    required: true,
    validate: (value) => tryError(() => parseClockTime(value)),
    ...io,
  });
  if (text === null) return null;
  return parseClockTime(text);
}

function tryError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

export function viewJobs(out, env = process.env) {
  const jobs = listJobs(env);
  if (!jobs.length) {
    out.write(color.dim('No jobs yet. Schedule one first.\n\n'));
    return;
  }
  out.write(`${renderJobsTable(jobs)}\n\n`);
}

export function renderJobsTable(jobs, now = Date.now()) {
  const statusColor = { pending: color.cyan, running: color.yellow, done: color.green, failed: color.red, cancelled: color.dim, overdue: color.red };
  const rows = jobs.map((job) => [
    job.id,
    job.agentName,
    displayStatus(job, now),
    job.status === 'pending' ? describeRunAt(job.runAt, new Date(now)) : new Date(job.runAt).toLocaleString(),
    job.mode === 'resume' ? (job.sessionId ?? '').slice(0, 12) : 'new session',
    job.project,
  ]);
  const header = ['ID', 'AGENT', 'STATUS', 'LAUNCH', 'SESSION', 'PROJECT'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells, decorate) => cells
    .map((cell, column) => {
      const text = String(cell).padEnd(widths[column]);
      return decorate && column === 2 ? (statusColor[cell] ?? color.dim)(text) : text;
    })
    .join('  ')
    .trimEnd();
  return [color.dim(line(header)), ...rows.map((row) => line(row, true))].join('\n');
}

async function cancelFlow({ io, env, out }) {
  const pending = listJobs(env).filter((job) => job.status === 'pending');
  if (!pending.length) {
    out.write(color.dim('No pending jobs to cancel.\n\n'));
    return;
  }
  const jobId = await select('Which job do you want to cancel?', pending.map((job) => ({
    label: `${job.id} · ${job.agentName}`,
    value: job.id,
    hint: describeRunAt(job.runAt),
  })), io);
  if (!jobId) return;
  const sure = await confirm(`Cancel ${jobId}?`, { def: true, ...io });
  if (!sure) return;
  cancelJob(jobId, env);
  out.write(`${color.green('✔')} Cancelled ${jobId}.\n\n`);
}
