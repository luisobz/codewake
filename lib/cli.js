import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachOpen,
  DEFAULT_RESUME_PROMPT,
  prepareOpen,
  retryFromSpec,
  scheduleFromSpec,
} from './actions.js';
import {
  cancelJob,
  clearJobs,
  displayStatus,
  loadJob,
  logFile,
  runJob,
  waitJob,
} from './jobs.js';
import { describeRunAt } from './time.js';
import { color } from './tui.js';
import { runWizard, viewJobs } from './wizard.js';

export { resolveRunAt } from './actions.js';

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

export function version() {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version;
}

export function usage() {
  return `${color.bold('codewake')} — schedule your coding agents to pick up where they left off

Usage:
  codewake                     Interactive console (detect agents, pick a
                               session, schedule the resume job)
  codewake jobs                List scheduled and finished jobs
  codewake open <job-id>       Reopen a job's session in its agent's own UI
                               (add --skip-permissions to skip approval prompts)
  codewake logs <job-id>       Show a job's status and output
  codewake cancel <job-id>     Cancel a pending job
  codewake retry <job-id>      Reschedule a failed, finished or overdue job
  codewake clear               Remove finished jobs from the list
  codewake agents              Show which agents are installed
  codewake schedule [options]  Non-interactive scheduling

Schedule options:
  --agent <id>          Agent to launch (see "codewake agents")
  --session <id>        Session to resume
  --new                 Start a new session instead of resuming
  --prompt <text>       Prompt to send (resume default: "${DEFAULT_RESUME_PROMPT}";
                        required with --new)
  --skip-permissions    Let the agent run unattended (its "yolo" flag)
  --project <dir>       Working directory (default: current directory)
  --in <duration>       Launch after a delay, e.g. "2h 30m"
  --at <HH:MM>          Launch at a time (today, or tomorrow if past)
  --now                 Launch immediately (default)
  --bin <path>          Override the detected executable
  --dry-run             Print what would run without scheduling

Retry options:
  --now | --in <duration> | --at <HH:MM>   When to launch again (default: now)
  --prompt <text>                          Override the prompt to send
  --project <dir>                          Override the working directory

Examples:
  codewake
  codewake schedule --agent claude --session 550e8400 --in 2h30m
  codewake schedule --agent codex --new --prompt "run the test suite" --at 06:00
  codewake retry mrouq7ln-rkv5 --in 5s`;
}

export function parseArgs(argv) {
  const [first, ...rest] = argv;
  if (first === undefined) return { command: 'wizard' };
  switch (first) {
    case 'help':
    case '--help':
    case '-h':
      return { command: 'help' };
    case '--version':
    case '-v':
      return { command: 'version' };
    case 'jobs':
    case 'list':
      return { command: 'jobs' };
    case 'agents':
      return { command: 'agents' };
    case 'clear':
      return { command: 'clear' };
    case 'logs':
      if (!rest[0]) throw new Error('Usage: codewake logs <job-id>');
      return { command: 'logs', jobId: rest[0] };
    case 'cancel':
      if (!rest[0]) throw new Error('Usage: codewake cancel <job-id>');
      return { command: 'cancel', jobId: rest[0] };
    case 'open': {
      if (!rest[0]) throw new Error('Usage: codewake open <job-id> [--skip-permissions]');
      const [jobId, ...flags] = rest;
      let skipPermissions = false;
      for (const flag of flags) {
        if (flag === '--skip-permissions') skipPermissions = true;
        else throw new Error(`Unknown option: ${flag}. Run "codewake --help".`);
      }
      return { command: 'open', jobId, skipPermissions };
    }
    case 'retry':
      return parseRetryArgs(rest);
    case 'schedule':
      return parseScheduleArgs(rest);
    case '--run':
      return { command: 'run', jobId: rest[0] };
    case '--wait':
      return { command: 'wait', jobId: rest[0] };
    default:
      throw new Error(`Unknown command: ${first}. Run "codewake --help".`);
  }
}

function parseScheduleArgs(argv) {
  const result = {
    command: 'schedule',
    agentId: null,
    sessionId: null,
    isNew: false,
    prompt: null,
    skipPermissions: false,
    project: process.cwd(),
    when: { type: 'now' },
    bin: null,
    dryRun: false,
  };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value.`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--agent') result.agentId = value(i, flag), i += 1;
    else if (flag === '--session') result.sessionId = value(i, flag), i += 1;
    else if (flag === '--new') result.isNew = true;
    else if (flag === '--prompt') result.prompt = value(i, flag), i += 1;
    else if (flag === '--skip-permissions') result.skipPermissions = true;
    else if (flag === '--project') result.project = resolve(value(i, flag)), i += 1;
    else if (flag === '--in') result.when = { type: 'in', value: value(i, flag) }, i += 1;
    else if (flag === '--at') result.when = { type: 'at', value: value(i, flag) }, i += 1;
    else if (flag === '--now') result.when = { type: 'now' };
    else if (flag === '--bin') result.bin = value(i, flag), i += 1;
    else if (flag === '--dry-run') result.dryRun = true;
    else throw new Error(`Unknown option: ${flag}. Run "codewake --help".`);
  }
  if (!result.agentId) throw new Error('--agent is required. See "codewake agents" for ids.');
  if (result.isNew && result.sessionId) throw new Error('Use either --session or --new, not both.');
  if (!result.isNew && !result.sessionId) throw new Error('Pass --session <id> to resume, or --new to start fresh.');
  if (result.isNew && !result.prompt?.trim()) throw new Error('--prompt is required when starting a new session.');
  return result;
}

function parseRetryArgs(argv) {
  const [jobId, ...rest] = argv;
  if (!jobId || jobId.startsWith('-')) {
    throw new Error('Usage: codewake retry <job-id> [--now | --in <duration> | --at <HH:MM>]');
  }
  const result = { command: 'retry', jobId, when: { type: 'now' }, prompt: null, project: null, dryRun: false };
  const value = (i, flag) => {
    if (rest[i + 1] === undefined) throw new Error(`${flag} needs a value.`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--in') result.when = { type: 'in', value: value(i, flag) }, i += 1;
    else if (flag === '--at') result.when = { type: 'at', value: value(i, flag) }, i += 1;
    else if (flag === '--now') result.when = { type: 'now' };
    else if (flag === '--prompt') result.prompt = value(i, flag), i += 1;
    else if (flag === '--project') result.project = resolve(value(i, flag)), i += 1;
    else if (flag === '--dry-run') result.dryRun = true;
    else throw new Error(`Unknown option: ${flag}. Run "codewake --help".`);
  }
  return result;
}

/** Status header shown by "codewake logs", separate from the raw output. */
export function describeJobHeader(job, now = Date.now()) {
  const outcome = [
    job.exitCode !== undefined && job.exitCode !== null ? `exit ${job.exitCode}` : null,
    job.signal ? `signal ${job.signal}` : null,
  ].filter(Boolean).join(', ');
  const lines = [`Job ${job.id} · ${job.agentName} · ${displayStatus(job, now)}${outcome ? ` (${outcome})` : ''}`];
  lines.push(job.startedAt
    ? `  started ${new Date(job.startedAt).toLocaleString()} in ${job.project}`
    : `  scheduled for ${new Date(job.runAt).toLocaleString()} in ${job.project}`);
  if (job.error) lines.push(`  error: ${job.error}`);
  return lines.join('\n');
}

export function renderAgentsReport(detected) {
  const nameWidth = Math.max(...detected.map(({ agent }) => `${agent.name} (${agent.id})`.length));
  return detected
    .map(({ agent, bin }) => {
      const mark = bin ? color.green('✔') : color.dim('✘');
      const location = bin ? color.dim(bin) : color.dim('not found');
      const caps = [agent.resume ? 'resume' : null, agent.create ? 'new' : null].filter(Boolean).join(' + ');
      const name = `${agent.name} (${agent.id})`.padEnd(nameWidth);
      return `${mark} ${name}  ${caps.padEnd(12)} ${location}`;
    })
    .join('\n');
}

export async function main(argv) {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'help':
      console.log(usage());
      return;
    case 'version':
      console.log(version());
      return;
    case 'wizard':
      if (!process.stdin.isTTY) {
        throw new Error('The interactive console needs a terminal. Use "codewake schedule" with flags instead.');
      }
      await runWizard({ version: version() });
      return;
    case 'jobs':
      viewJobs(process.stdout);
      return;
    case 'logs': {
      let job = null;
      try {
        job = loadJob(args.jobId);
      } catch {
        // Job record already cleared; the log may still be around.
      }
      const path = job?.log ?? logFile(args.jobId);
      // Header goes to stderr so "codewake logs id > out.txt" stays clean.
      if (job) process.stderr.write(`${color.dim(describeJobHeader(job))}\n`);
      if (existsSync(path)) {
        process.stdout.write(readFileSync(path, 'utf8'));
      } else if (!job) {
        throw new Error(`No job or log found for ${args.jobId}.`);
      } else if (job.status === 'pending') {
        process.stderr.write(color.dim(`No output yet — the job launches ${describeRunAt(job.runAt)}.\n`));
      } else {
        process.stderr.write(color.dim('The job produced no output.\n'));
      }
      return;
    }
    case 'cancel': {
      const { warning } = cancelJob(args.jobId);
      console.log(`${color.green('✔')} Cancelled ${args.jobId}.`);
      if (warning) console.log(`${color.yellow('!')} ${warning}`);
      return;
    }
    case 'clear': {
      const removed = clearJobs();
      console.log(removed.length ? `Removed ${removed.length} finished job(s).` : 'Nothing to clean up.');
      return;
    }
    case 'agents':
      console.log(renderAgentsReport(detectAgents(loadAgents())));
      return;
    case 'run':
      await runJob(args.jobId);
      return;
    case 'wait':
      await waitJob(args.jobId);
      return;
    case 'open': {
      if (!process.stdin.isTTY) {
        throw new Error('"codewake open" attaches an interactive UI and needs a terminal.');
      }
      const job = loadJob(args.jobId);
      if (job.status === 'running') {
        console.log(`${color.yellow('!')} Job ${job.id} is still running headless; you are opening the same session alongside it.`);
      }
      const prepared = prepareOpen(job, process.env, { skipPermissions: args.skipPermissions });
      if (prepared.note) console.log(`${color.yellow('!')} ${prepared.note}`);
      console.log(color.dim(`Opening ${prepared.agent.name}: ${prepared.preview}`));
      await attachOpen(prepared);
      return;
    }
    case 'schedule':
    case 'retry': {
      const { job, preview, note } = args.command === 'retry'
        ? retryFromSpec(args)
        : scheduleFromSpec(args);
      if (note) console.log(`${color.yellow('!')} ${note}`);
      if (args.dryRun) {
        console.log(`Would launch ${describeRunAt(job.runAt)} in ${job.project}:`);
        console.log(`  ${preview}`);
        return;
      }
      console.log(`${color.green('✔')} Job ${color.bold(job.id)} scheduled ${describeRunAt(job.runAt)}.`);
      console.log(color.dim(`  ${preview}`));
      console.log(color.dim(`  Watch it with "codewake jobs" and "codewake logs ${job.id}".`));
      return;
    }
    default:
      throw new Error(`Unhandled command: ${args.command}`);
  }
}
