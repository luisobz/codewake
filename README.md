# agent-resume

**Schedule your coding agents to pick up where they left off.**

`agent-resume` is an interactive CLI that detects the coding agents installed on your machine — Claude Code, OpenAI Codex CLI, GitHub Copilot CLI, Gemini CLI, Cursor CLI, OpenCode, Aider, Goose, Amp, Qwen Code — lets you pick a session (or start a new one), choose a prompt, and launches the agent at the time you choose. Hit a usage limit at 2 AM? Schedule the resume for when it resets and go to sleep.

- **Interactive console** — arrow keys, sensible defaults, a summary before anything is scheduled.
- **Agent auto-detection** — scans your `PATH` for every supported agent; extend or override the list with a small JSON config.
- **Session discovery** — lists your existing Claude Code and Codex sessions (with titles and timestamps) for the current project; other agents accept a session id or start fresh.
- **Job management** — list, inspect logs, cancel, and clean up scheduled jobs from the console or with subcommands.
- **Zero dependencies** — plain Node.js ≥ 18. Prompts are never passed through a shell, so no quoting surprises.

## Install

```bash
npm install --global agent-resume
```

Or from a checkout of this repository:

```bash
npm link
```

## Quick start

```bash
agent-resume
```

The console walks you through it:

1. **Pick an agent** — only agents actually found on your `PATH` are offered.
2. **Pick a session** — existing sessions for the current project, enter a session id manually, or start a new session.
3. **Prompt** — optional when resuming (defaults to `continue`), required for new sessions.
4. **Permissions** — choose whether the agent runs unattended (its "skip permissions" / "yolo" flag) or interactively.
5. **When** — right now, after a delay (`2h 30m`), or at a clock time (`06:00`).
6. Review the exact command in the summary and confirm.

```
✔ Which agent do you want to launch? Claude Code
✔ Which session do you want to resume? Ship the new API
✔ Prompt to send (continue)
✔ Skip permission prompts? [y/N] y
✔ When should it launch? After a delay
✔ Delay 2h 30m

Summary
  Agent        Claude Code
  Session      550e8400-e29b-41d4-a716-446655440000
  Prompt       continue
  Permissions  skipped (unattended)
  Launch       in 2h 30m (Jul 16, 04:10 PM)
  Project      ~/work/my-app
  Command      claude --resume 550e8400-… -p continue --dangerously-skip-permissions

✔ Job k2f9qz-ab12 scheduled in 2h 30m.
```

## Managing jobs

From the console (`agent-resume`) or directly:

```bash
agent-resume jobs             # list scheduled and finished jobs
agent-resume logs <job-id>    # output captured from the agent run
agent-resume cancel <job-id>  # cancel a pending job
agent-resume clear            # drop finished/cancelled jobs from the list
agent-resume agents           # which agents were detected, and where
```

## Non-interactive scheduling

Everything the console does is available as flags — handy for scripts:

```bash
agent-resume schedule --agent claude --session 550e8400 --in 2h30m
agent-resume schedule --agent codex --new --prompt "run the test suite and fix failures" --at 06:00 --skip-permissions
agent-resume schedule --agent claude --session refactor-api --now --dry-run
```

`--dry-run` prints the exact command without scheduling anything.

## Supported agents

| Agent | Binary | Resume | New session | Session discovery |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | ✔ | ✔ | `~/.claude/projects` (per project, with titles) |
| OpenAI Codex CLI | `codex` | ✔ | ✔ | `~/.codex/sessions` rollouts (filtered by cwd) |
| GitHub Copilot CLI | `copilot` | ✔ | ✔ | `~/.copilot/history-session-state` |
| Cursor CLI | `cursor-agent` | ✔ | ✔ | manual session id |
| OpenCode | `opencode` | ✔ | ✔ | manual session id |
| Aider | `aider` | ✔ (chat history) | ✔ | `.aider.chat.history.md` in the project |
| Goose | `goose` | ✔ | ✔ | `~/.local/share/goose/sessions` |
| Amp | `amp` | ✔ | ✔ | manual session id |
| Gemini CLI | `gemini` | – | ✔ | – |
| Qwen Code | `qwen` | – | ✔ | – |

Agent CLIs move fast. If a flag changes upstream, or you use an agent we don't know about, you don't have to wait for a release — see the next section.

## Custom agents

Add or override agents in `~/.config/agent-resume/config.json` (or point `AGENT_RESUME_CONFIG` somewhere else). Entries have the same shape as the built-in registry (`lib/registry.js`):

```json
{
  "agents": [
    {
      "id": "mycli",
      "name": "My CLI",
      "bins": ["mycli"],
      "resume": { "args": ["--continue", "{session}", "--ask", "{prompt}"], "skip": ["--yes"] },
      "create": { "args": ["--ask", "{prompt}"], "skip": ["--yes"] }
    },
    { "id": "claude", "bins": ["claude-nightly"] }
  ],
  "disabled": ["amp"]
}
```

`{session}` and `{prompt}` are substituted as whole argv elements — commands are spawned directly, never through a shell. `AGENT_RESUME_BIN_<ID>` (e.g. `AGENT_RESUME_BIN_CLAUDE=/opt/claude`) overrides detection for a single agent.

## How scheduling works

- On **Linux with systemd**, jobs are armed with a transient user timer (`systemd-run --user --on-active=…`), so they survive the terminal closing. If your machine logs you out completely, enable lingering once: `loginctl enable-linger "$USER"`.
- **Everywhere else** (macOS, Windows, containers), a small detached Node process waits for the launch time. It survives the terminal closing, but not a reboot.

Job state and logs live in `~/.local/state/agent-resume/` (override with `AGENT_RESUME_STATE_DIR`). Jobs whose launch time passed without running (e.g. after a reboot) show up as `overdue` in `agent-resume jobs` — reschedule them.

## A word about unattended runs

Choosing *skip permissions* passes the agent's own bypass flag (for example `--dangerously-skip-permissions` for Claude Code). The agent will edit files and run commands without asking. Only schedule projects you trust, review the prompt before confirming, and keep your work under version control. `agent-resume` always shows the exact command in the summary and defaults to **not** skipping permissions.

## Development

```bash
npm test                        # zero-dependency test suite (node --test)
node bin/agent-resume.js        # run the console from the checkout
```

The test suite covers argument parsing, duration/time parsing, the agent registry, command building, session discovery (with fixtures), the job store and both scheduling backends, and the interactive console end to end (driven through fake terminals).

## License

MIT
