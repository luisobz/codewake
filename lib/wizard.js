import { homedir } from 'node:os';
import { buildCommand, commandPreview, configPath, detectAgents, loadAgents } from './agents.js';
import { askWhen, browseJobs, renderJobsTable } from './browser.js';
import { findPendingForSession, listJobs, scheduleJob } from './jobs.js';
import { listSessions, resolveSessionPlacement } from './sessions.js';
import { describeRunAt, timeAgo } from './time.js';
import { color, confirm, input, select } from './tui.js';

// Re-exported so existing importers (tests, cli) keep one entry point.
export { renderJobsTable, shortenPath } from './browser.js';

const DEFAULT_RESUME_PROMPT = 'continue';
const EXIT_WINDOW_MS = 5000;

/**
 * Interactive console. `io` lets tests inject stdin/stdout. There is no
 * Exit item: pressing a cancel key (ctrl+c, ctrl+d, esc, q) at the menu
 * twice within 5 seconds leaves — the first press explains that.
 */
export async function runWizard({ version = '', io = {}, env = process.env } = {}) {
  const out = io.stdout ?? process.stdout;
  out.write(`\n${color.bold('codewake')}${version ? color.dim(` v${version}`) : ''} ${color.dim('— schedule your coding agents to pick up where they left off')}\n\n`);
  let lastCancel = { key: null, at: 0 };
  for (;;) {
    const action = await select('What do you want to do?', [
      { label: 'Schedule / wake an agent', value: 'schedule', hint: 'pick agent → session → prompt → time' },
      { label: 'Waked agents', value: 'browse', hint: 'browse jobs: open, retry, cancel, sweep' },
    ], { ...io, cancelInfo: true });
    if (action?.cancelled) {
      const now = Date.now();
      if (lastCancel.key === action.key && now - lastCancel.at <= EXIT_WINDOW_MS) {
        out.write(color.dim('Bye!\n'));
        return;
      }
      lastCancel = { key: action.key, at: now };
      out.write(color.dim(`Press ${action.key} again within 5s to exit.\n`));
      continue;
    }
    lastCancel = { key: null, at: 0 };
    if (action === 'schedule') await scheduleFlow({ io, env, out });
    else if (action === 'browse' && await browseJobs({ io, env }) === 'exit') {
      out.write(color.dim('Bye!\n'));
      return;
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

  // Agents like Claude Code can only resume a session from the project it
  // belongs to; correct the working directory now instead of failing later.
  let project = process.cwd();
  if (mode === 'resume' && sessionId) {
    let placement;
    try {
      placement = resolveSessionPlacement(agent, sessionId, { project, home: env.HOME || homedir() });
    } catch (error) {
      out.write(`${color.red('✘')} ${error.message}\n\n`);
      return;
    }
    if (placement.note) out.write(`${color.yellow('!')} ${placement.note}\n`);
    project = placement.project;
  }

  // Two jobs resuming the same session would race each other — refuse early.
  const duplicate = findPendingForSession(agent.id, sessionId, env);
  if (duplicate) {
    out.write(`${color.yellow('!')} This session already has a pending job (${color.bold(duplicate.id)}, ${describeRunAt(duplicate.runAt)}).\n`);
    out.write(color.dim(`  Cancel it first if you want to reschedule: codewake cancel ${duplicate.id}\n\n`));
    return;
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
  let job;
  try {
    job = scheduleJob({ agent, bin, args, mode, sessionId, prompt, skipPermissions, project, runAt }, { env });
  } catch (error) {
    out.write(`${color.red('✘')} ${error.message}\n\n`);
    return;
  }
  out.write(`${color.green('✔')} Job ${color.bold(job.id)} scheduled ${describeRunAt(job.runAt)}.\n`);
  out.write(color.dim(`  Manage it with "codewake jobs", "codewake logs ${job.id}" or "codewake cancel ${job.id}".\n\n`));
}

export function viewJobs(out, env = process.env) {
  const jobs = listJobs(env);
  if (!jobs.length) {
    out.write(color.dim('No jobs yet. Schedule one first.\n\n'));
    return;
  }
  out.write(`${renderJobsTable(jobs, Date.now(), { width: out.columns })}\n\n`);
}

