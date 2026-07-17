import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommand, commandPreview, detectAgents, loadAgents } from './agents.js';
import {
  cancelJob,
  clearJobs,
  listJobs,
  logFile,
  runJob,
  scheduleJob,
  waitJob,
} from './jobs.js';
import { describeRunAt, parseClockTime, parseDuration } from './time.js';
import { color } from './tui.js';
import { runWizard, viewJobs } from './wizard.js';

const DEFAULT_RESUME_PROMPT = 'continue';
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
  codewake logs <job-id>       Show the output of a job
  codewake cancel <job-id>     Cancel a pending job
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

Examples:
  codewake
  codewake schedule --agent claude --session 550e8400 --in 2h30m
  codewake schedule --agent codex --new --prompt "run the test suite" --at 06:00`;
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

export function resolveRunAt(when, now = new Date()) {
  if (when.type === 'in') return new Date(now.getTime() + parseDuration(when.value) * 1000);
  if (when.type === 'at') return parseClockTime(when.value, now);
  return now;
}

function scheduleFromArgs(args, env = process.env) {
  const detected = detectAgents(loadAgents({ env }), { env });
  const entry = detected.find((candidate) => candidate.agent.id === args.agentId);
  if (!entry) {
    const known = detected.map((candidate) => candidate.agent.id).join(', ');
    throw new Error(`Unknown agent "${args.agentId}". Known agents: ${known}.`);
  }
  const bin = args.bin ?? entry.bin;
  if (!bin) {
    throw new Error(`${entry.agent.name} is not installed (looked for: ${entry.agent.bins.join(', ')}). Use --bin to point at it.`);
  }
  const mode = args.isNew ? 'create' : 'resume';
  const prompt = args.prompt?.trim() || DEFAULT_RESUME_PROMPT;
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
    project: args.project,
    runAt: resolveRunAt(args.when),
  }, { dryRun: args.dryRun, env });
  return { job, preview: commandPreview(bin, commandArgs) };
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
      const path = logFile(args.jobId);
      if (!existsSync(path)) {
        throw new Error(`No log for job ${args.jobId} yet (it appears at ${path} once the job runs).`);
      }
      process.stdout.write(readFileSync(path, 'utf8'));
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
    case 'schedule': {
      const { job, preview } = scheduleFromArgs(args);
      if (args.dryRun) {
        console.log(`Would launch ${describeRunAt(job.runAt)} in ${job.project}:`);
        console.log(`  ${preview}`);
        return;
      }
      console.log(`${color.green('✔')} Job ${color.bold(job.id)} scheduled ${describeRunAt(job.runAt)}.`);
      console.log(color.dim(`  ${preview}`));
      console.log(color.dim(`  Manage it with "codewake jobs" or "codewake cancel ${job.id}".`));
      return;
    }
    default:
      throw new Error(`Unhandled command: ${args.command}`);
  }
}
