import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeClaudeProject,
  listSessions,
  locateSession,
  resolveSessionPlacement,
} from '../lib/sessions.js';
import { BUILTIN_AGENTS } from '../lib/registry.js';

const byId = Object.fromEntries(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'codewake-home-'));
}

test('encodeClaudeProject matches Claude Code path encoding', () => {
  assert.equal(encodeClaudeProject('/home/user/my.app'), '-home-user-my-app');
});

test('claude sessions are read from the encoded project directory', () => {
  const home = makeHome();
  const project = mkdtempSync(join(tmpdir(), 'codewake-project-'));
  const dir = join(home, '.claude', 'projects', encodeClaudeProject(project));
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, '11111111-aaaa.jsonl'), [
    JSON.stringify({ type: 'summary', summary: 'Refactor the API layer' }),
    JSON.stringify({ type: 'user', message: { content: 'ignored' } }),
  ].join('\n'));
  writeFileSync(join(dir, '22222222-bbbb.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '  fix   the flaky test  ' }] } }),
  ].join('\n'));
  // Make the second file clearly newer so ordering is deterministic.
  utimesSync(join(dir, '11111111-aaaa.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));

  const sessions = listSessions(byId.claude, { project, home });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, '22222222-bbbb');
  assert.equal(sessions[0].title, 'fix the flaky test');
  assert.equal(sessions[1].title, 'Refactor the API layer');
});

test('claude sessions in other projects are not listed', () => {
  const home = makeHome();
  const project = mkdtempSync(join(tmpdir(), 'codewake-project-'));
  const dir = join(home, '.claude', 'projects', encodeClaudeProject(`${project}-other`));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'x.jsonl'), JSON.stringify({ type: 'summary', summary: 'other' }));
  assert.deepEqual(listSessions(byId.claude, { project, home }), []);
});

test('codex rollouts are discovered recursively and filtered by cwd', () => {
  const home = makeHome();
  const project = mkdtempSync(join(tmpdir(), 'codewake-project-'));
  const day = join(home, '.codex', 'sessions', '2026', '07', '15');
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, 'rollout-2026-07-15T10-00-00-aaaa1111.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'aaaa1111', cwd: project } })}\n`,
  );
  writeFileSync(
    join(day, 'rollout-2026-07-15T11-00-00-bbbb2222.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'bbbb2222', cwd: `${project}-elsewhere` } })}\n`,
  );

  const local = listSessions(byId.codex, { project, home });
  assert.deepEqual(local.map((session) => session.id), ['aaaa1111']);

  // With no local match, every session is offered.
  const all = listSessions(byId.codex, { project: `${project}-new`, home });
  assert.equal(all.length, 2);
});

test('codex rollouts fall back to the filename id when meta is unparsable', () => {
  const home = makeHome();
  const day = join(home, '.codex', 'sessions', '2026', '07', '15');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-07-15T10-00-00-cccc3333.jsonl'), 'not json\n');
  const sessions = listSessions(byId.codex, { project: '/x', home });
  assert.deepEqual(sessions.map((session) => session.id), ['cccc3333']);
});

test('aider exposes the project history as a single pseudo-session', () => {
  const project = mkdtempSync(join(tmpdir(), 'codewake-aider-'));
  assert.deepEqual(listSessions(byId.aider, { project, home: makeHome() }), []);
  writeFileSync(join(project, '.aider.chat.history.md'), '# chat\n');
  const sessions = listSessions(byId.aider, { project, home: makeHome() });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'project-history');
});

test('agents without session discovery return an empty list', () => {
  assert.deepEqual(listSessions(byId.gemini, { project: '/x', home: makeHome() }), []);
  assert.deepEqual(listSessions(byId.cursor, { project: '/x', home: makeHome() }), []);
});

test('session discovery never throws on unreadable state', () => {
  const home = join(makeHome(), 'does-not-exist');
  assert.deepEqual(listSessions(byId.claude, { project: '/x', home }), []);
  assert.deepEqual(listSessions(byId.codex, { project: '/x', home }), []);
});

// --- locateSession / resolveSessionPlacement ---

function makeClaudeSession(home, project, sessionId, cwd = project) {
  const dir = join(home, '.claude', 'projects', encodeClaudeProject(project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'file-history-snapshot' }),
    JSON.stringify({ type: 'user', cwd, message: { content: 'hola' } }),
  ].join('\n'));
}

test('locateSession finds a claude session in any project and recovers its cwd', () => {
  const home = makeHome();
  const realProject = mkdtempSync(join(tmpdir(), 'codewake-real-'));
  makeClaudeSession(home, realProject, 'f456f2d4-aaaa');
  assert.deepEqual(
    locateSession(byId.claude, 'f456f2d4-aaaa', { home }),
    { found: true, project: realProject },
  );
  assert.deepEqual(locateSession(byId.claude, 'missing-id', { home }), { found: false });
});

test('locateSession stays neutral when it cannot search', () => {
  const home = makeHome(); // no ~/.claude at all
  assert.equal(locateSession(byId.claude, 'anything', { home }), null);
  assert.equal(locateSession(byId.cursor, 'anything', { home }), null); // manual strategy
  assert.equal(locateSession(byId.claude, '../escape', { home }), null); // hostile id
});

test('locateSession matches codex rollouts by id', () => {
  const home = makeHome();
  const day = join(home, '.codex', 'sessions', '2026', '07', '15');
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, 'rollout-2026-07-15T10-00-00-aaaa1111.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'aaaa1111', cwd: '/work/demo' } })}\n`,
  );
  assert.deepEqual(locateSession(byId.codex, 'aaaa1111', { home }), { found: true, project: '/work/demo' });
  assert.deepEqual(locateSession(byId.codex, 'zzzz9999', { home }), { found: false });
});

test('resolveSessionPlacement moves the job to the directory the session lives in', () => {
  const home = makeHome();
  const realProject = mkdtempSync(join(tmpdir(), 'codewake-real-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'codewake-elsewhere-'));
  makeClaudeSession(home, realProject, 'sess-1');

  const moved = resolveSessionPlacement(byId.claude, 'sess-1', { project: elsewhere, home });
  assert.equal(moved.project, realProject);
  assert.match(moved.note, /belongs to/);

  const same = resolveSessionPlacement(byId.claude, 'sess-1', { project: realProject, home });
  assert.equal(same.project, realProject);
  assert.equal(same.note, null);
});

test('resolveSessionPlacement rejects a session id that exists nowhere', () => {
  const home = makeHome();
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  assert.throws(
    () => resolveSessionPlacement(byId.claude, 'no-such-session', { project: tmpdir(), home }),
    /exists on this machine/,
  );
});

test('resolveSessionPlacement rejects a session whose own directory is gone', () => {
  const home = makeHome();
  const realProject = mkdtempSync(join(tmpdir(), 'codewake-real-'));
  makeClaudeSession(home, realProject, 'sess-2');
  rmSync(realProject, { recursive: true, force: true });
  assert.throws(
    () => resolveSessionPlacement(byId.claude, 'sess-2', { project: tmpdir(), home }),
    /no longer exists/,
  );
});

test('resolveSessionPlacement keeps the project when nothing can be concluded', () => {
  const home = makeHome();
  const project = mkdtempSync(join(tmpdir(), 'codewake-any-'));
  assert.deepEqual(
    resolveSessionPlacement(byId.claude, 'whatever', { project, home }),
    { project, note: null },
  );
  assert.deepEqual(
    resolveSessionPlacement(byId.cursor, 'whatever', { project, home }),
    { project, note: null },
  );
});
