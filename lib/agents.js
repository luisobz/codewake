import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { BUILTIN_AGENTS } from './registry.js';

export function configPath(env = process.env) {
  if (env.AGENT_RESUME_CONFIG) return resolve(env.AGENT_RESUME_CONFIG);
  const configHome = env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(configHome, 'agent-resume', 'config.json');
}

/**
 * Built-in registry merged with the user's config file. The config may
 * override built-ins by id, add brand new agents, and disable ids:
 *   { "agents": [{ "id": "mycli", ... }], "disabled": ["amp"] }
 */
export function loadAgents({ env = process.env } = {}) {
  const agents = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
  const path = configPath(env);
  if (!existsSync(path)) return [...agents.values()];
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error.message}`);
  }
  for (const entry of config.agents ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`Every agent in ${path} needs a string "id".`);
    }
    const merged = { ...agents.get(entry.id), ...entry };
    validateAgent(merged, path);
    agents.set(merged.id, merged);
  }
  for (const id of config.disabled ?? []) agents.delete(id);
  return [...agents.values()];
}

function validateAgent(agent, source) {
  const problem = (message) => new Error(`Invalid agent "${agent.id}" in ${source}: ${message}`);
  if (!agent.name || typeof agent.name !== 'string') throw problem('missing "name".');
  if (!Array.isArray(agent.bins) || !agent.bins.length) throw problem('"bins" must be a non-empty array.');
  if (!agent.resume && !agent.create) throw problem('needs a "resume" or "create" command spec.');
  for (const key of ['resume', 'create']) {
    const spec = agent[key];
    if (spec && (!Array.isArray(spec.args) || !spec.args.length)) {
      throw problem(`"${key}.args" must be a non-empty array.`);
    }
  }
}

/** Resolve a command on PATH without spawning a shell. */
export function which(command, env = process.env) {
  const tryPath = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  };
  if (command.includes('/') || command.includes('\\')) {
    return tryPath(isAbsolute(command) ? command : resolve(command));
  }
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => ext.toLowerCase())
    : [''];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const found = tryPath(join(dir, command + ext));
      if (found) return found;
    }
  }
  return null;
}

/**
 * Probe which agents are installed. Returns [{ agent, bin }] for every
 * registered agent; `bin` is the resolved executable path or null.
 * AGENT_RESUME_BIN_<ID> overrides detection for a single agent.
 */
export function detectAgents(agents, { env = process.env } = {}) {
  return agents.map((agent) => {
    const override = env[`AGENT_RESUME_BIN_${agent.id.toUpperCase().replaceAll('-', '_')}`];
    const bin = override
      ? which(override, env)
      : agent.bins.map((candidate) => which(candidate, env)).find(Boolean) ?? null;
    return { agent, bin };
  });
}

/**
 * Build the argv for a job. Placeholders are substituted inside argv
 * elements — the command is spawned directly, never through a shell.
 */
export function buildCommand(agent, { mode, sessionId, prompt, skipPermissions = false }) {
  const spec = mode === 'resume' ? agent.resume : agent.create;
  if (!spec) {
    const action = mode === 'resume' ? 'resuming sessions' : 'starting new sessions';
    throw new Error(`${agent.name} does not support ${action} from agent-resume.`);
  }
  const args = spec.args.map((part) =>
    part.replaceAll('{session}', sessionId ?? '').replaceAll('{prompt}', prompt ?? ''),
  );
  if (skipPermissions && spec.skip) args.push(...spec.skip);
  return args;
}

/** Shell-quoted preview of a command, for display only. */
export function commandPreview(bin, args) {
  return [bin, ...args]
    .map((part) => (/[^\w@%+=:,./-]/.test(part) || part === '' ? `'${part.replaceAll("'", "'\\''")}'` : part))
    .join(' ');
}
