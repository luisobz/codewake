/**
 * Built-in agent registry: the list of coding agents `codewake` knows
 * how to detect and drive. Each entry is plain data so users can add or
 * override agents from ~/.config/codewake/config.json with the same shape.
 *
 * Fields:
 *   id        stable identifier used on the command line (`--agent claude`)
 *   name      display name
 *   bins      executable names probed on PATH, first hit wins
 *   sessions  session-discovery strategy (see lib/sessions.js):
 *             'claude-projects' | 'codex-rollouts' | 'copilot-history' |
 *             'goose-sessions'  | 'aider-history'  | 'manual' | 'none'
 *   resume    command spec to resume an existing session (omit if unsupported)
 *   create    command spec to start a new session (omit if unsupported)
 *
 * Command specs:
 *   args      argv template; '{session}' and '{prompt}' are substituted as
 *             whole argv elements (never through a shell, so no quoting bugs)
 *   skip      extra argv appended when the user opts into skipping
 *             permission/approval prompts (omit if the agent has no such flag)
 */
export const BUILTIN_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bins: ['claude'],
    sessions: 'claude-projects',
    resume: {
      args: ['--resume', '{session}', '-p', '{prompt}'],
      skip: ['--dangerously-skip-permissions'],
    },
    create: {
      args: ['-p', '{prompt}'],
      skip: ['--dangerously-skip-permissions'],
    },
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    bins: ['codex'],
    sessions: 'codex-rollouts',
    resume: {
      args: ['exec', 'resume', '{session}', '{prompt}'],
      skip: ['--dangerously-bypass-approvals-and-sandbox'],
    },
    create: {
      args: ['exec', '{prompt}'],
      skip: ['--dangerously-bypass-approvals-and-sandbox'],
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bins: ['gemini'],
    sessions: 'none',
    create: {
      args: ['-p', '{prompt}'],
      skip: ['--yolo'],
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    bins: ['copilot'],
    sessions: 'copilot-history',
    resume: {
      args: ['--resume', '{session}', '-p', '{prompt}'],
      skip: ['--allow-all-tools'],
    },
    create: {
      args: ['-p', '{prompt}'],
      skip: ['--allow-all-tools'],
    },
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    bins: ['cursor-agent'],
    sessions: 'manual',
    resume: {
      args: ['--resume', '{session}', '-p', '{prompt}'],
      skip: ['--force'],
    },
    create: {
      args: ['-p', '{prompt}'],
      skip: ['--force'],
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bins: ['opencode'],
    sessions: 'manual',
    resume: {
      args: ['run', '--session', '{session}', '{prompt}'],
    },
    create: {
      args: ['run', '{prompt}'],
    },
  },
  {
    id: 'aider',
    name: 'Aider',
    bins: ['aider'],
    sessions: 'aider-history',
    resume: {
      args: ['--restore-chat-history', '--message', '{prompt}'],
      skip: ['--yes-always'],
    },
    create: {
      args: ['--message', '{prompt}'],
      skip: ['--yes-always'],
    },
  },
  {
    id: 'goose',
    name: 'Goose',
    bins: ['goose'],
    sessions: 'goose-sessions',
    resume: {
      args: ['run', '--name', '{session}', '--resume', '--text', '{prompt}'],
    },
    create: {
      args: ['run', '--text', '{prompt}'],
    },
  },
  {
    id: 'amp',
    name: 'Amp',
    bins: ['amp'],
    sessions: 'manual',
    resume: {
      args: ['threads', 'continue', '{session}', '-x', '{prompt}'],
      skip: ['--dangerously-allow-all'],
    },
    create: {
      args: ['-x', '{prompt}'],
      skip: ['--dangerously-allow-all'],
    },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    bins: ['qwen'],
    sessions: 'none',
    create: {
      args: ['-p', '{prompt}'],
      skip: ['--yolo'],
    },
  },
];
