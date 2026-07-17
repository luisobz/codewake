# codewake

**Schedule your coding agents to pick up where they left off.**

`codewake` is an interactive CLI that detects the coding agents installed on your machine — Claude Code, OpenAI Codex CLI, GitHub Copilot CLI, Gemini CLI, Cursor CLI, OpenCode, Aider, Goose, Amp, Qwen Code — lets you pick a session (or start a new one), choose a prompt, and launches the agent at the time you choose. Hit a usage limit at 2 AM? Schedule the resume for when it resets and go to sleep.

- **Interactive console** — two entries: *Schedule / wake an agent* and *Waked agents*, a job browser with agent/text filters where every action is one key (open, retry, cancel, sweep) and the shortcuts are always visible. Leave with a double ctrl+c/ctrl+d.
- **Open a job's session** — jump from any job straight into the agent's own terminal UI (`claude --resume …`, `codex resume …`, …) to watch or take over what the agent did.
- **Agent auto-detection** — scans your `PATH` for every supported agent; extend or override the list with a small JSON config.
- **Session discovery** — lists your existing Claude Code and Codex sessions (with titles and timestamps) for the current project; other agents accept a session id or start fresh.
- **Right-place resumes** — agents like Claude Code can only resume a session from the project directory it belongs to. codewake locates the session across all your projects and runs the job from the right directory (and tells you), instead of failing later with "No conversation found". If the project moved between scheduling and launch, the job follows it.
- **Job management** — list, inspect logs, cancel, and clean up scheduled jobs from the console or with subcommands.
- **Suspend-safe scheduling** — timers track the wall clock, so a laptop that sleeps through the launch time fires the job right after waking instead of drifting.
- **Cross-platform** — Linux (systemd user timers), macOS, and Windows (detached waiter, `.cmd`-shim aware); CI runs on all three.
- **Zero dependencies** — plain Node.js ≥ 18. Prompts are never passed through a shell, so no quoting surprises.

## Install

```bash
npm install --global codewake
```

Or from a checkout of this repository:

```bash
npm link
```

## Quick start

```bash
codewake
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

From the console (`codewake`) or directly:

```bash
codewake jobs             # list scheduled and finished jobs
codewake open <job-id>    # reopen the job's session in its agent's own UI
codewake logs <job-id>    # job status plus the output captured from the run
codewake cancel <job-id>  # cancel a pending job
codewake retry <job-id>   # reschedule a failed/finished/overdue job
                          #   (--now, --in, --at, --prompt, --project)
codewake clear            # drop finished/cancelled jobs from the list
codewake agents           # which agents were detected, and where
```

Or interactively: `codewake` → **Waked agents** browses every job — `↑↓` move, `enter` opens the session in the agent's own terminal, `r` retries (asks when + prompt), `x` cancels, `s` sweeps finished jobs, `f` filters by agent, `/` searches, `esc` goes back. The shortcut bar at the bottom always shows what each key does.

## Non-interactive scheduling

Everything the console does is available as flags — handy for scripts:

```bash
codewake schedule --agent claude --session 550e8400 --in 2h30m
codewake schedule --agent codex --new --prompt "run the test suite and fix failures" --at 06:00 --skip-permissions
codewake schedule --agent claude --session refactor-api --now --dry-run
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

Add or override agents in `~/.config/codewake/config.json` (or point `CODEWAKE_CONFIG` somewhere else). Entries have the same shape as the built-in registry (`lib/registry.js`):

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

`{session}` and `{prompt}` are substituted as whole argv elements — commands are spawned directly, never through a shell. `CODEWAKE_BIN_<ID>` (e.g. `CODEWAKE_BIN_CLAUDE=/opt/claude`) overrides detection for a single agent.

## How scheduling works

- On **Linux with systemd**, jobs are armed with a transient user timer (`systemd-run --user --on-calendar=…`). Wall-clock timers keep ticking through laptop suspend and fire on resume if their time passed while the lid was closed. They survive the terminal closing; if your machine logs you out completely, enable lingering once: `loginctl enable-linger "$USER"`.
- On **macOS, Windows, and Linux without systemd**, a small detached Node process waits for the launch time. It re-checks the wall clock every minute rather than sleeping once, so a machine that suspends overnight launches the job right after waking instead of drifting by the suspended time. It survives the terminal closing, but not a reboot.

A session can only have **one pending job** at a time — scheduling a second resume for the same session is refused until you cancel the first, so two agents never race each other over one transcript. Jobs whose launch time passed without running (e.g. after a reboot) show up as `overdue` in `codewake jobs` — reschedule them with `codewake retry <job-id>`.

### Where state and logs live

| OS | Job state | Execution logs |
| --- | --- | --- |
| Linux | `~/.local/state/codewake/` | `~/.local/state/codewake/logs/` |
| macOS | `~/Library/Application Support/codewake/` | `~/Library/Logs/codewake/` |
| Windows | `%LOCALAPPDATA%\codewake\` | `%LOCALAPPDATA%\codewake\Logs\` |

Every job run captures the agent's stdout/stderr to `<job-id>.log`, readable with `codewake logs <job-id>`. `CODEWAKE_STATE_DIR` overrides the state location (logs move under `<dir>/logs`). On Windows, npm-installed agents (`.cmd` shims) are launched through `cmd.exe` with every argument escaped — never an interpolated shell string.

## A word about unattended runs

Choosing *skip permissions* passes the agent's own bypass flag (for example `--dangerously-skip-permissions` for Claude Code). The agent will edit files and run commands without asking. Only schedule projects you trust, review the prompt before confirming, and keep your work under version control. `codewake` always shows the exact command in the summary and defaults to **not** skipping permissions.

## Development

```bash
npm test                        # zero-dependency test suite (node --test)
node bin/codewake.js        # run the console from the checkout
```

The test suite covers argument parsing, duration/time parsing, the agent registry, command building, session discovery (with fixtures), the job store and both scheduling backends, and the interactive console end to end (driven through fake terminals).

## License

MIT
