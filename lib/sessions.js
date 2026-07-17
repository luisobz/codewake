import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const HEAD_BYTES = 128 * 1024;
const TITLE_LENGTH = 64;

/**
 * Discover resumable sessions for an agent. Always returns an array
 * (possibly empty), newest first: [{ id, title, updatedAt }].
 */
export function listSessions(agent, { project = process.cwd(), home = homedir() } = {}) {
  const strategy = STRATEGIES[agent.sessions] ?? STRATEGIES.none;
  try {
    return strategy({ project: resolve(project), home })
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  } catch {
    return [];
  }
}

/** Claude Code encodes a project path by replacing non-alphanumerics with '-'. */
export function encodeClaudeProject(project) {
  return project.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Look a session id up across everything the agent has stored on this
 * machine, regardless of project. Returns:
 *   null                        lookup is unsupported or nothing could be
 *                               searched, so nothing can be concluded
 *   { found: false }            the store was searched and the id is not there
 *   { found: true, project }    found; `project` is the directory the session
 *                               was recorded in, or null when unknown
 */
export function locateSession(agent, sessionId, { home = homedir() } = {}) {
  const lookup = LOCATORS[agent.sessions];
  if (!lookup || typeof sessionId !== 'string' || !/^[\w.-]+$/.test(sessionId)) return null;
  try {
    return lookup(sessionId, home);
  } catch {
    return null;
  }
}

/**
 * Decide the directory a resume job must run from. Agents like Claude Code
 * only find a session when launched from the project it belongs to, so a
 * mismatched working directory fails with "No conversation found". Returns
 * { project, note }; `note` explains the correction when the requested
 * project was overridden. Throws when the session provably does not exist
 * on this machine, or when its own directory is gone.
 */
export function resolveSessionPlacement(agent, sessionId, { project, home = homedir() } = {}) {
  const requested = resolve(project);
  const located = locateSession(agent, sessionId, { home });
  if (!located) return { project: requested, note: null };
  if (!located.found) {
    throw new Error(
      `No ${agent.name} session "${sessionId}" exists on this machine. ` +
      'Double-check the id (run "codewake" and pick the session from the list).',
    );
  }
  const actual = located.project ? resolve(located.project) : null;
  if (!actual || actual === requested) return { project: requested, note: null };
  if (!existsSync(actual)) {
    throw new Error(
      `Session ${sessionId} belongs to ${actual}, but that directory no longer exists. ` +
      `${agent.name} can only resume it from there — restore the directory first.`,
    );
  }
  return {
    project: actual,
    note: `Session ${sessionId} belongs to ${actual}; the job will run there instead of ${requested}.`,
  };
}

const LOCATORS = {
  'claude-projects': (sessionId, home) => {
    const root = join(home, '.claude', 'projects');
    if (!existsSync(root)) return null;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, `${sessionId}.jsonl`);
      if (existsSync(path)) return { found: true, project: claudeCwd(path) };
    }
    return { found: false };
  },

  'codex-rollouts': (sessionId, home) => {
    const root = join(home, '.codex', 'sessions');
    if (!existsSync(root)) return null;
    for (const { path, name } of walkFiles(root, /^rollout-.*\.jsonl$/)) {
      const meta = firstJsonLine(path);
      const payload = meta?.payload ?? meta;
      const id = payload?.id
        ?? /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(name)?.[1];
      if (id !== sessionId) continue;
      return { found: true, project: typeof payload?.cwd === 'string' ? payload.cwd : null };
    }
    return { found: false };
  },

  'copilot-history': (sessionId, home) => {
    const dir = join(home, '.copilot', 'history-session-state');
    if (!existsSync(dir)) return null;
    return { found: existsSync(join(dir, `${sessionId}.json`)), project: null };
  },

  'goose-sessions': (sessionId, home) => {
    const dir = join(home, '.local', 'share', 'goose', 'sessions');
    if (!existsSync(dir)) return null;
    return { found: existsSync(join(dir, `${sessionId}.jsonl`)), project: null };
  },
};

/** First working directory recorded inside a Claude Code session file. */
function claudeCwd(path) {
  for (const line of head(path).split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd;
    } catch {
      continue;
    }
  }
  return null;
}

const STRATEGIES = {
  none: () => [],
  manual: () => [],

  'claude-projects': ({ project, home }) => {
    const dir = join(home, '.claude', 'projects', encodeClaudeProject(project));
    return listFiles(dir, /\.jsonl$/).map(({ path, name, mtime }) => ({
      id: name.replace(/\.jsonl$/, ''),
      title: claudeTitle(path) ?? 'Untitled session',
      updatedAt: mtime,
    }));
  },

  'codex-rollouts': ({ project, home }) => {
    const root = join(home, '.codex', 'sessions');
    const sessions = [];
    for (const { path, name, mtime } of walkFiles(root, /^rollout-.*\.jsonl$/)) {
      const meta = firstJsonLine(path);
      const payload = meta?.payload ?? meta;
      const id = payload?.id
        ?? /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(name)?.[1];
      if (!id) continue;
      const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
      sessions.push({ id, title: cwd ?? 'Codex session', updatedAt: mtime, cwd });
    }
    const local = sessions.filter((session) => session.cwd === project);
    return local.length ? local : sessions;
  },

  'copilot-history': ({ home }) => {
    const dir = join(home, '.copilot', 'history-session-state');
    return listFiles(dir, /\.json$/).map(({ name, mtime }) => ({
      id: name.replace(/\.json$/, ''),
      title: 'Copilot session',
      updatedAt: mtime,
    }));
  },

  'goose-sessions': ({ home }) => {
    const dir = join(home, '.local', 'share', 'goose', 'sessions');
    return listFiles(dir, /\.jsonl$/).map(({ path, name, mtime }) => ({
      id: name.replace(/\.jsonl$/, ''),
      title: cleanTitle(firstJsonLine(path)?.description) ?? 'Goose session',
      updatedAt: mtime,
    }));
  },

  'aider-history': ({ project }) => {
    const history = join(project, '.aider.chat.history.md');
    if (!existsSync(history)) return [];
    return [{
      id: 'project-history',
      title: 'Chat history of this project',
      updatedAt: statSync(history).mtime,
    }];
  },
};

function listFiles(dir, pattern) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { path, name: entry.name, mtime: statSync(path).mtime };
    });
}

function walkFiles(dir, pattern, depth = 4) {
  if (depth < 0 || !existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path, pattern, depth - 1));
    else if (entry.isFile() && pattern.test(entry.name)) {
      found.push({ path, name: entry.name, mtime: statSync(path).mtime });
    }
  }
  return found;
}

function head(path, bytes = HEAD_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.toString('utf8', 0, read);
  } finally {
    closeSync(fd);
  }
}

function firstJsonLine(path) {
  const line = head(path, 16 * 1024).split('\n').find((candidate) => candidate.trim());
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function claudeTitle(path) {
  let firstUserMessage = null;
  for (const line of head(path).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'summary' && entry.summary) return cleanTitle(entry.summary);
    if (!firstUserMessage && entry.type === 'user') {
      const content = entry.message?.content;
      if (typeof content === 'string') firstUserMessage = content;
      else if (Array.isArray(content)) {
        firstUserMessage = content.find((part) => part?.type === 'text')?.text ?? null;
      }
    }
  }
  return cleanTitle(firstUserMessage);
}

function cleanTitle(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
}
