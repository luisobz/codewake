import { homedir } from 'node:os';
import { emitKeypressEvents } from 'node:readline';
import {
  attachOpen,
  DEFAULT_RESUME_PROMPT,
  prepareOpen,
  retryFromSpec,
} from './actions.js';
import { cancelJob, clearJobs, displayStatus, listJobs } from './jobs.js';
import { describeRunAt, parseClockTime, parseDuration } from './time.js';
import { cancelKeyName, color, confirm, input, select } from './tui.js';

const EXIT_WINDOW_MS = 5000;
const PAGE_SIZE = 10;

/** Shorten a path for display: home becomes ~, long paths keep their tail. */
export function shortenPath(path, max, home = homedir()) {
  let short = path;
  if (home && short.startsWith(home)) short = `~${short.slice(home.length)}`;
  if (short.length > max) short = `…${short.slice(short.length - max + 1)}`;
  return short;
}

const truncate = (text, max) =>
  (text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text);

/**
 * Fixed-width jobs table that always fits `width` columns: the PROJECT
 * column absorbs the remaining space (shortened from the left), and is
 * dropped entirely when the terminal is too narrow for it. With
 * `selected >= 0` that row gets a pointer and highlight (browser mode).
 */
export function renderJobsTable(jobs, now = Date.now(), {
  width = process.stdout.columns || 120,
  selected = -1,
} = {}) {
  const statusColor = { pending: color.cyan, running: color.yellow, done: color.green, failed: color.red, cancelled: color.dim, overdue: color.red };
  const pointerPad = selected >= 0 ? 2 : 0;
  const rows = jobs.map((job) => [
    job.id,
    truncate(job.agentName, 20),
    displayStatus(job, now),
    truncate(job.status === 'pending' ? describeRunAt(job.runAt, new Date(now)) : new Date(job.runAt).toLocaleString(), 28),
    job.mode === 'resume' ? truncate(job.sessionId ?? '', 12) : 'new session',
    job.project,
  ]);
  let header = ['ID', 'AGENT', 'STATUS', 'LAUNCH', 'SESSION', 'PROJECT'];
  const columnWidth = (column) =>
    Math.max(header[column].length, ...rows.map((row) => String(row[column]).length));
  const gap = 2;
  const fixedWidth = header.slice(0, -1).reduce((sum, _title, column) => sum + columnWidth(column) + gap, 0);
  const projectSpace = width - pointerPad - fixedWidth;
  if (projectSpace >= 'PROJECT'.length) {
    for (const row of rows) row[5] = shortenPath(row[5], projectSpace);
  } else {
    header = header.slice(0, 5);
    for (const row of rows) row.length = 5;
  }
  const widths = header.map((_title, column) => columnWidth(column));
  const line = (cells, decorate, isSelected = false) => cells
    .map((cell, column) => {
      const text = String(cell).padEnd(widths[column]);
      if (decorate && column === 2) return (statusColor[cell] ?? color.dim)(text);
      return isSelected ? color.cyan(text) : text;
    })
    .join(' '.repeat(gap))
    .trimEnd();
  const pointer = (i) => {
    if (selected < 0) return '';
    return i === selected ? color.cyan('❯ ') : '  ';
  };
  return [
    color.dim(`${selected >= 0 ? '  ' : ''}${line(header)}`),
    ...rows.map((row, i) => `${pointer(i)}${line(row, true, i === selected)}`),
  ].join('\n');
}

/** Ask when a job should launch: now, after a delay, or at a clock time. */
export async function askWhen(io) {
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

const HINTS = '↑↓ move · enter open · r retry · x cancel · s sweep finished · f agent · / search · esc back · ctrl+c ×2 exit';
const SEARCH_HINTS = '(enter keep · esc clear · ↑↓ still move)';

/**
 * Interactive job browser ("Waked agents"): navigate every job, filter by
 * agent (f) or free text (/), open the selected job's session in its
 * agent's own terminal UI (enter), retry (r), cancel (x) and sweep the
 * finished ones (s). Resolves 'menu' (esc/q) or 'exit' (double ctrl+c/d).
 */
export function browseJobs({ io = {}, env = process.env } = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  // Tests drive fake streams; only a real terminal can be handed to agents.
  const attachedStdio = stdin === process.stdin && stdout === process.stdout ? 'inherit' : 'ignore';

  return new Promise((resolvePromise) => {
    let jobs = listJobs(env);
    let index = 0;
    let top = 0;
    let agentFilter = null;
    let search = '';
    let searchActive = false;
    let flash = null;
    let renderedLines = 0;
    let busy = false;
    let lastCancel = { key: null, at: 0 };

    emitKeypressEvents(stdin);
    const raw = typeof stdin.setRawMode === 'function';

    const agentChoices = () => [...new Map(jobs.map((job) => [job.agentId, job.agentName])).entries()];

    const visible = () => jobs.filter((job) => {
      if (agentFilter && job.agentId !== agentFilter) return false;
      if (!search) return true;
      const haystack = [
        job.id, job.agentName, job.sessionId ?? '', job.prompt ?? '', job.project, displayStatus(job),
      ].join(' ').toLowerCase();
      return haystack.includes(search.toLowerCase());
    });

    const render = () => {
      const rows = visible();
      if (index >= rows.length) index = Math.max(0, rows.length - 1);
      if (index < top) top = index;
      if (index >= top + PAGE_SIZE) top = index - PAGE_SIZE + 1;
      if (top > 0 && top + PAGE_SIZE > rows.length) top = Math.max(0, rows.length - PAGE_SIZE);
      if (renderedLines) stdout.write(`\x1b[${renderedLines}A`);
      if (stdout.isTTY) stdout.write('\x1b[0J');
      const width = stdout.columns || 120;
      const filters = [
        agentFilter ? `agent: ${agentChoices().find(([id]) => id === agentFilter)?.[1] ?? agentFilter}` : null,
        search ? `search: "${search}"` : null,
      ].filter(Boolean).join(' · ');
      const lines = [
        `${color.bold('Waked agents', stdout)} ${color.dim(`${rows.length}/${jobs.length} job${jobs.length === 1 ? '' : 's'}${filters ? ` · ${filters}` : ''}`, stdout)}`,
      ];
      if (!rows.length) {
        lines.push(color.dim(jobs.length ? '  Nothing matches the current filters.' : '  No jobs yet — schedule one first.', stdout));
      } else {
        if (top > 0) lines.push(color.dim(`  ↑ ${top} more`, stdout));
        const page = rows.slice(top, top + PAGE_SIZE);
        lines.push(...renderJobsTable(page, Date.now(), { width, selected: index - top }).split('\n'));
        const below = rows.length - Math.min(rows.length, top + PAGE_SIZE);
        if (below > 0) lines.push(color.dim(`  ↓ ${below} more`, stdout));
      }
      if (flash) lines.push(...flash.split('\n'));
      lines.push(color.dim(searchActive ? `search: ${search}▌  ${SEARCH_HINTS}` : HINTS, stdout));
      renderedLines = lines.length;
      stdout.write(`${lines.join('\n')}\n`);
    };

    const attach = () => {
      if (raw) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKeypress);
      if (stdout.isTTY) stdout.write('\x1b[?25l');
      render();
    };

    const detach = () => {
      stdin.removeListener('keypress', onKeypress);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      if (stdout.isTTY) {
        stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        stdout.write('\x1b[?25h');
      }
      renderedLines = 0;
    };

    const finish = (result) => {
      detach();
      resolvePromise(result);
    };

    /** Leave the raw-key loop, run a prompt-based flow, come back and redraw. */
    const dialog = (fn) => {
      busy = true;
      detach();
      (async () => {
        try {
          await fn();
        } catch (error) {
          flash = `${color.red('✘', stdout)} ${error.message}`;
        } finally {
          jobs = listJobs(env);
          busy = false;
          attach();
        }
      })();
    };

    const openAction = (job) => dialog(async () => {
      if (job.status === 'running') {
        const anyway = await confirm(
          `Job ${job.id} is still running headless — open the same session alongside it?`,
          { def: false, stdin, stdout },
        );
        if (!anyway) return;
      }
      const prepared = prepareOpen(job, env);
      if (prepared.note) stdout.write(`${color.yellow('!', stdout)} ${prepared.note}\n`);
      stdout.write(color.dim(`Opening ${prepared.agent.name} — leave it to come back here.\n`, stdout));
      const code = await attachOpen(prepared, { stdio: attachedStdio });
      flash = color.dim(`${prepared.agent.name} closed (exit ${code}).`, stdout);
    });

    const retryAction = (job) => dialog(async () => {
      const status = displayStatus(job);
      if (!['failed', 'done', 'cancelled', 'overdue'].includes(status)) {
        flash = `${color.yellow('!', stdout)} Job ${job.id} is ${status}; only finished or overdue jobs can be retried.`;
        return;
      }
      const runAt = await askWhen({ stdin, stdout });
      if (runAt === null) return;
      const prompt = job.mode === 'resume'
        ? await input('Prompt to send', { def: job.prompt || DEFAULT_RESUME_PROMPT, stdin, stdout })
        : await input('Prompt for the new session', { def: job.prompt, required: true, stdin, stdout });
      if (prompt === null) return;
      const { job: fresh, note } = retryFromSpec(
        { jobId: job.id, when: runAt, prompt, project: null, dryRun: false },
        env,
      );
      flash = [
        note ? `${color.yellow('!', stdout)} ${note}` : null,
        `${color.green('✔', stdout)} Rescheduled as ${color.bold(fresh.id, stdout)} (launching ${describeRunAt(fresh.runAt)}).`,
      ].filter(Boolean).join('\n');
    });

    const cancelAction = (job) => dialog(async () => {
      if (job.status !== 'pending') {
        flash = `${color.yellow('!', stdout)} Job ${job.id} is ${displayStatus(job)}; only pending jobs can be cancelled.`;
        return;
      }
      const sure = await confirm(`Cancel ${job.id}?`, { def: true, stdin, stdout });
      if (!sure) return;
      const { warning } = cancelJob(job.id, env);
      flash = warning
        ? `${color.yellow('!', stdout)} Cancelled ${job.id} — ${warning}`
        : `${color.green('✔', stdout)} Cancelled ${job.id}.`;
    });

    const sweepAction = () => dialog(async () => {
      const finished = jobs.filter((job) => ['done', 'failed', 'cancelled'].includes(job.status));
      if (!finished.length) {
        flash = color.dim('Nothing to clean up.', stdout);
        return;
      }
      const sure = await confirm(
        `Remove ${finished.length} finished job${finished.length === 1 ? '' : 's'}?`,
        { def: true, stdin, stdout },
      );
      if (!sure) return;
      const removed = clearJobs(env);
      flash = `${color.green('✔', stdout)} Removed ${removed.length} job${removed.length === 1 ? '' : 's'}.`;
    });

    const move = (delta) => {
      const rows = visible();
      if (!rows.length) return;
      index = (index + delta + rows.length) % rows.length;
      render();
    };

    const onKeypress = (str, key = {}) => {
      if (busy) return;
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        const name = cancelKeyName(str, key);
        const now = Date.now();
        if (lastCancel.key === name && now - lastCancel.at <= EXIT_WINDOW_MS) {
          finish('exit');
          return;
        }
        lastCancel = { key: name, at: now };
        flash = color.dim(`Press ${name} again within 5s to exit.`, stdout);
        render();
        return;
      }
      if (key.name === 'up') { move(-1); return; }
      if (key.name === 'down') { move(1); return; }
      if (searchActive) {
        if (key.name === 'return' || key.name === 'enter') searchActive = false;
        else if (key.name === 'escape') { searchActive = false; search = ''; index = 0; top = 0; }
        else if (key.name === 'backspace') search = search.slice(0, -1);
        else if (str && !key.ctrl && !key.meta && str >= ' ') { search += str; index = 0; top = 0; }
        else return;
        render();
        return;
      }
      if (key.name === 'escape' || str === 'q') { finish('menu'); return; }
      if (str === 'k') { move(-1); return; }
      if (str === 'j') { move(1); return; }
      if (str === '/') { searchActive = true; flash = null; render(); return; }
      if (str === 'f') {
        const ids = agentChoices().map(([id]) => id);
        const at = agentFilter ? ids.indexOf(agentFilter) : -1;
        agentFilter = at + 1 >= ids.length ? null : ids[at + 1];
        index = 0;
        top = 0;
        render();
        return;
      }
      if (str === 's') { flash = null; sweepAction(); return; }
      const job = visible()[index];
      if (!job) return;
      if (key.name === 'return' || key.name === 'enter') { flash = null; openAction(job); return; }
      if (str === 'r') { flash = null; retryAction(job); return; }
      if (str === 'x') { flash = null; cancelAction(job); return; }
    };

    attach();
  });
}
