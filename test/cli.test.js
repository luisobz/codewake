import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli.js';

test('analiza una reanudación con horas y minutos', () => {
  const result = parseArgs(['sesion-123', '-h', '2', '-m', '28']);
  assert.equal(result.command, 'schedule');
  assert.equal(result.session, 'sesion-123');
  assert.equal(result.hours, 2);
  assert.equal(result.minutes, 28);
});

test('rechaza una espera de cero', () => {
  assert.throws(() => parseArgs(['sesion-123', '-h', '0', '-m', '0']), /mayor que cero/);
});

test('acepta los comandos administrativos', () => {
  assert.deepEqual(parseArgs(['list']), { command: 'list' });
  assert.deepEqual(parseArgs(['cancel', '123-abc']), { command: 'cancel', jobId: '123-abc' });
});
