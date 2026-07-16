import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirm, input, select } from '../lib/tui.js';

function makeIo() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  let rendered = '';
  stdout.on('data', (chunk) => {
    rendered += chunk;
  });
  return { stdin, stdout, output: () => rendered };
}

test('select returns the highlighted value on enter', async () => {
  const io = makeIo();
  const picked = select('Pick one', ['alpha', 'beta', 'gamma'], io);
  io.stdin.write('j'); // down
  io.stdin.write('\r');
  assert.equal(await picked, 'beta');
  assert.match(io.output(), /alpha/);
});

test('select supports object choices and number shortcuts', async () => {
  const io = makeIo();
  const picked = select('Pick one', [
    { label: 'First', value: 1 },
    { label: 'Second', value: 2, hint: '(hint)' },
  ], io);
  io.stdin.write('2');
  assert.equal(await picked, 2);
  assert.match(io.output(), /\(hint\)/);
});

test('select wraps around the list edges', async () => {
  const io = makeIo();
  const picked = select('Pick one', ['a', 'b', 'c'], io);
  io.stdin.write('k'); // up from the first item wraps to the last
  io.stdin.write('\r');
  assert.equal(await picked, 'c');
});

test('select resolves null on ctrl+c', async () => {
  const io = makeIo();
  const picked = select('Pick one', ['a', 'b'], io);
  io.stdin.write('\x03');
  assert.equal(await picked, null);
});

test('select paginates long lists', async () => {
  const io = makeIo();
  const items = Array.from({ length: 30 }, (_, i) => `item-${i}`);
  const picked = select('Pick one', items, { ...io, pageSize: 5 });
  io.stdin.write('\r');
  assert.equal(await picked, 'item-0');
  assert.match(io.output(), /↓ 25 more/);
  assert.ok(!io.output().includes('item-29'));
});

test('input returns the typed value trimmed', async () => {
  const io = makeIo();
  const answer = input('Prompt', io);
  io.stdin.write('  hello world  \n');
  assert.equal(await answer, 'hello world');
});

test('input falls back to the default on empty answers', async () => {
  const io = makeIo();
  const answer = input('Prompt', { def: 'continue', ...io });
  io.stdin.write('\n');
  assert.equal(await answer, 'continue');
});

test('input re-asks while required or invalid', async () => {
  const io = makeIo();
  const answer = input('Delay', {
    required: true,
    validate: (value) => (value === 'ok' ? null : 'try again'),
    ...io,
  });
  io.stdin.write('\n');
  io.stdin.write('bad\n');
  io.stdin.write('ok\n');
  assert.equal(await answer, 'ok');
  assert.match(io.output(), /required/);
  assert.match(io.output(), /try again/);
});

test('confirm parses yes/no with a default', async () => {
  const yes = makeIo();
  const answered = confirm('Sure?', yes);
  yes.stdin.write('y\n');
  assert.equal(await answered, true);

  const fallback = makeIo();
  const defaulted = confirm('Sure?', { def: true, ...fallback });
  fallback.stdin.write('\n');
  assert.equal(await defaulted, true);

  const no = makeIo();
  const declined = confirm('Sure?', no);
  no.stdin.write('no\n');
  assert.equal(await declined, false);
});
