import { spawn } from 'node:child_process';

/**
 * Escape one argument for cmd.exe (same algorithm as the cross-spawn
 * package): backslash-escape quotes, quote the whole argument, then
 * caret-escape cmd metacharacters so nothing is interpreted by the shell.
 */
export function escapeCmdArg(argument) {
  let escaped = String(argument);
  // Double up backslashes that precede a quote, escape the quote itself.
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so they don't escape the closing quote.
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  // Neutralize cmd.exe metacharacters.
  escaped = escaped.replace(/[!^&|<>()%"]/g, '^$&');
  return escaped;
}

const WINDOWS_SHIM = /\.(cmd|bat)$/i;

/**
 * Spawn an agent binary portably. On Windows, npm installs CLIs as
 * .cmd/.bat shims which cannot be spawned directly (Node raises EINVAL);
 * those are run through cmd.exe with every argument escaped — never with
 * `shell: true`, which would leave arguments uninterpreted-quoted.
 */
export function spawnAgent(bin, args, options = {}) {
  if (process.platform === 'win32' && WINDOWS_SHIM.test(bin)) {
    const command = [escapeCmdArg(bin), ...args.map(escapeCmdArg)].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(bin, args, options);
}
