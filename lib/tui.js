import { createInterface, emitKeypressEvents } from 'node:readline';

const useColor = (stream = process.stdout) => Boolean(stream.isTTY) && !('NO_COLOR' in process.env);

const paint = (code, close = 39) => (text, stream) =>
  useColor(stream) ? `\x1b[${code}m${text}\x1b[${close}m` : String(text);

export const color = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
  magenta: paint(35),
};

/**
 * Arrow-key select menu. Returns the chosen value, or null when the user
 * cancels (esc / ctrl+c / q). Choices are strings or
 * { label, value, hint } objects. Long lists scroll inside `pageSize`.
 */
export function select(message, choices, {
  stdin = process.stdin,
  stdout = process.stdout,
  pageSize = 10,
} = {}) {
  const items = choices.map((choice) =>
    typeof choice === 'string' ? { label: choice, value: choice } : choice,
  );
  if (!items.length) return Promise.resolve(null);
  return new Promise((resolvePromise) => {
    let index = 0;
    let top = 0;
    let renderedLines = 0;
    emitKeypressEvents(stdin);
    const raw = typeof stdin.setRawMode === 'function';
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    if (stdout.isTTY) stdout.write('\x1b[?25l');

    const render = () => {
      if (renderedLines) stdout.write(`\x1b[${renderedLines}A`);
      if (stdout.isTTY) stdout.write('\x1b[0J');
      const lines = [
        `${color.green('?', stdout)} ${color.bold(message, stdout)} ${color.dim('(↑/↓ · enter · esc cancels)', stdout)}`,
      ];
      if (top > 0) lines.push(color.dim(`    ↑ ${top} more`, stdout));
      const end = Math.min(items.length, top + pageSize);
      for (let i = top; i < end; i += 1) {
        const item = items[i];
        const active = i === index;
        const pointer = active ? color.cyan('❯', stdout) : ' ';
        const label = active ? color.cyan(item.label, stdout) : item.label;
        const hint = item.hint ? ` ${color.dim(item.hint, stdout)}` : '';
        lines.push(`  ${pointer} ${label}${hint}`);
      }
      if (end < items.length) lines.push(color.dim(`    ↓ ${items.length - end} more`, stdout));
      renderedLines = lines.length;
      stdout.write(`${lines.join('\n')}\n`);
    };

    const finish = (value) => {
      stdin.removeListener('keypress', onKeypress);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      if (stdout.isTTY) {
        stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        const answer = value === null
          ? color.dim('cancelled', stdout)
          : color.cyan(items[index].label, stdout);
        stdout.write(`${color.green('✔', stdout)} ${color.bold(message, stdout)} ${answer}\n`);
        stdout.write('\x1b[?25h');
      }
      resolvePromise(value);
    };

    const move = (delta) => {
      index = (index + delta + items.length) % items.length;
      if (index < top) top = index;
      if (index >= top + pageSize) top = index - pageSize + 1;
      render();
    };

    const onKeypress = (str, key = {}) => {
      if (key.name === 'up' || str === 'k') move(-1);
      else if (key.name === 'down' || str === 'j') move(1);
      else if (key.name === 'return' || key.name === 'enter') finish(items[index].value);
      else if (key.name === 'escape' || str === 'q' || (key.ctrl && key.name === 'c')) finish(null);
      else if (/^[1-9]$/.test(str ?? '') && Number(str) <= items.length) {
        // Highlight only — instant-select would let a pasted answer like
        // "2h 30m" pick item 2 and leak "h 30m" into the next prompt.
        index = Number(str) - 1;
        top = Math.max(0, Math.min(index, items.length - pageSize));
        render();
      }
    };

    stdin.on('keypress', onKeypress);
    render();
  });
}

/**
 * Free-text prompt. Returns the value (trimmed), the default when the
 * answer is empty, or null when cancelled with ctrl+c.
 */
export async function input(message, {
  def,
  required = false,
  validate,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  const rl = createInterface({ input: stdin, output: stdout });
  // Queue lines instead of using rl.question(): fast input (or a paste with
  // newlines) can deliver several lines in one chunk, and question() drops
  // every line it is not currently waiting for.
  const lines = [];
  let waiter = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiter) {
      const deliver = waiter;
      waiter = null;
      deliver(line);
    } else {
      lines.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const deliver = waiter;
      waiter = null;
      deliver(null);
    }
  });
  rl.on('SIGINT', () => rl.close());
  const suffix = def ? ` ${color.dim(`(${def})`, stdout)}` : '';
  const question = `${color.green('?', stdout)} ${color.bold(message, stdout)}${suffix} `;
  const ask = () => {
    rl.setPrompt(question);
    rl.prompt();
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolveLine) => {
      waiter = resolveLine;
    });
  };
  try {
    for (;;) {
      const answer = await ask();
      if (answer === null) {
        stdout.write('\n');
        return null;
      }
      const value = answer.trim() || def || '';
      if (required && !value) {
        stdout.write(color.red('  This field is required.\n', stdout));
        continue;
      }
      if (validate && value !== '') {
        const error = validate(value);
        if (error) {
          stdout.write(color.red(`  ${error}\n`, stdout));
          continue;
        }
      }
      return value;
    }
  } finally {
    rl.close();
  }
}

/** Yes/no prompt. Returns boolean, or null when cancelled. */
export async function confirm(message, { def = false, stdin, stdout } = {}) {
  const answer = await input(`${message} ${color.dim(def ? '[Y/n]' : '[y/N]')}`, {
    stdin,
    stdout,
    validate: (value) => (/^(y|yes|n|no)$/i.test(value) ? null : 'Answer "y" or "n".'),
  });
  if (answer === null) return null;
  if (answer === '') return def;
  return /^y/i.test(answer);
}
