import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeCmdArg, spawnAgent } from '../lib/proc.js';

test('escapeCmdArg quotes plain and spaced arguments', () => {
  assert.equal(escapeCmdArg('plain'), '^"plain^"');
  assert.equal(escapeCmdArg('has space'), '^"has space^"');
});

test('escapeCmdArg escapes embedded quotes and trailing backslashes', () => {
  assert.equal(escapeCmdArg('say "hi"'), '^"say \\^"hi\\^"^"');
  assert.equal(escapeCmdArg('C:\\dir\\'), '^"C:\\dir\\\\^"');
});

test('escapeCmdArg neutralizes cmd metacharacters', () => {
  const escaped = escapeCmdArg('50% & (stuff) | more > out');
  assert.equal(escaped, '^"50^% ^& ^(stuff^) ^| more ^> out^"');
});

test('spawnAgent runs regular executables directly', async () => {
  const child = spawnAgent(process.execPath, ['-e', 'console.log("direct spawn ok")'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /direct spawn ok/);
});

test('spawnAgent runs .cmd shims through cmd.exe with escaped arguments', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-shim-'));
  const shim = join(dir, 'echo-args.cmd');
  writeFileSync(shim, '@echo off\r\necho %*\r\n');
  const child = spawnAgent(shim, ['hello world', 'a&b'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /hello world/);
  assert.match(output, /a&b/);
});
