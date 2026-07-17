import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCommand,
  commandPreview,
  detectAgents,
  loadAgents,
  which,
} from '../lib/agents.js';
import { BUILTIN_AGENTS } from '../lib/registry.js';

const claude = BUILTIN_AGENTS.find((agent) => agent.id === 'claude');
const codex = BUILTIN_AGENTS.find((agent) => agent.id === 'codex');
const gemini = BUILTIN_AGENTS.find((agent) => agent.id === 'gemini');

function makeFakeBin(dir, name) {
  // Windows resolves executables through PATHEXT, so fake a .cmd shim there.
  const path = process.platform === 'win32' ? join(dir, `${name}.cmd`) : join(dir, name);
  writeFileSync(path, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

test('registry entries are well-formed', () => {
  for (const agent of BUILTIN_AGENTS) {
    assert.ok(agent.id && agent.name, `${agent.id} has id and name`);
    assert.ok(agent.bins.length, `${agent.id} has bins`);
    assert.ok(agent.resume || agent.create, `${agent.id} has a command spec`);
    for (const spec of [agent.resume, agent.create].filter(Boolean)) {
      assert.ok(Array.isArray(spec.args) && spec.args.length);
    }
    if (agent.resume) {
      assert.ok(agent.resume.args.some((part) => part.includes('{session}')) || agent.id === 'aider',
        `${agent.id} resume references the session`);
    }
  }
});

test('buildCommand substitutes session and prompt as whole argv elements', () => {
  const args = buildCommand(claude, {
    mode: 'resume',
    sessionId: 'abc-123',
    prompt: 'continue; rm -rf / # stays a single argument',
  });
  assert.deepEqual(args, ['--resume', 'abc-123', '-p', 'continue; rm -rf / # stays a single argument']);
});

test('buildCommand appends the skip flag only when requested', () => {
  const cautious = buildCommand(claude, { mode: 'resume', sessionId: 's', prompt: 'p' });
  assert.ok(!cautious.includes('--dangerously-skip-permissions'));
  const unattended = buildCommand(claude, { mode: 'resume', sessionId: 's', prompt: 'p', skipPermissions: true });
  assert.equal(unattended.at(-1), '--dangerously-skip-permissions');
});

test('buildCommand builds new sessions for codex', () => {
  assert.deepEqual(
    buildCommand(codex, { mode: 'create', prompt: 'run the tests' }),
    ['exec', 'run the tests'],
  );
});

test('buildCommand does not re-expand placeholders found inside values', () => {
  const args = buildCommand(claude, {
    mode: 'resume',
    sessionId: '{prompt}',
    prompt: 'do the actual thing',
  });
  assert.deepEqual(args, ['--resume', '{prompt}', '-p', 'do the actual thing']);
  const reverse = buildCommand(claude, {
    mode: 'resume',
    sessionId: 'abc',
    prompt: 'mentions {session} literally',
  });
  assert.deepEqual(reverse, ['--resume', 'abc', '-p', 'mentions {session} literally']);
});

test('buildCommand refuses unsupported modes with a clear message', () => {
  assert.throws(
    () => buildCommand(gemini, { mode: 'resume', sessionId: 's', prompt: 'p' }),
    /does not support resuming/,
  );
});

test('commandPreview quotes arguments containing spaces', () => {
  assert.equal(
    commandPreview('/usr/bin/claude', ['-p', "it's here"]),
    "/usr/bin/claude -p 'it'\\''s here'",
  );
});

test('which finds executables on a custom PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-which-'));
  const bin = makeFakeBin(dir, 'claude');
  assert.equal(which('claude', { PATH: dir }), bin);
  assert.equal(which('nope', { PATH: dir }), null);
});

test('detectAgents reports installed and missing agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-detect-'));
  const claudeBin = makeFakeBin(dir, 'claude');
  const codexBin = makeFakeBin(dir, 'codex');
  const detected = detectAgents(BUILTIN_AGENTS, { env: { PATH: dir } });
  const byId = Object.fromEntries(detected.map(({ agent, bin }) => [agent.id, bin]));
  assert.equal(byId.claude, claudeBin);
  assert.equal(byId.codex, codexBin);
  assert.equal(byId.gemini, null);
});

test('CODEWAKE_BIN_<ID> overrides detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-override-'));
  const custom = makeFakeBin(dir, 'my-claude');
  const detected = detectAgents(BUILTIN_AGENTS, {
    env: { PATH: '/nonexistent', CODEWAKE_BIN_CLAUDE: custom },
  });
  assert.equal(detected.find(({ agent }) => agent.id === 'claude').bin, custom);
});

test('loadAgents merges user config: overrides, additions and disabling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-config-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({
    agents: [
      { id: 'claude', bins: ['claude-nightly'] },
      { id: 'mycli', name: 'My CLI', bins: ['mycli'], create: { args: ['go', '{prompt}'] } },
    ],
    disabled: ['amp'],
  }));
  const agents = loadAgents({ env: { CODEWAKE_CONFIG: config } });
  const claudeMerged = agents.find((agent) => agent.id === 'claude');
  assert.deepEqual(claudeMerged.bins, ['claude-nightly']);
  assert.equal(claudeMerged.name, 'Claude Code');
  assert.ok(agents.some((agent) => agent.id === 'mycli'));
  assert.ok(!agents.some((agent) => agent.id === 'amp'));
});

test('loadAgents rejects malformed custom agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-badconfig-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ agents: [{ id: 'broken', name: 'Broken', bins: ['x'] }] }));
  assert.throws(() => loadAgents({ env: { CODEWAKE_CONFIG: config } }), /"resume" or "create"/);
});

test('loadAgents without a config file returns the built-ins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codewake-noconfig-'));
  mkdirSync(join(dir, 'empty'), { recursive: true });
  const agents = loadAgents({ env: { CODEWAKE_CONFIG: join(dir, 'missing.json') } });
  assert.equal(agents.length, BUILTIN_AGENTS.length);
});
