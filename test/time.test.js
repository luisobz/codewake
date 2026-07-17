import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRunAt,
  formatDuration,
  parseClockTime,
  parseDuration,
  timeAgo,
} from '../lib/time.js';

test('parseDuration understands compound durations', () => {
  assert.equal(parseDuration('2h 30m'), 2 * 3600 + 30 * 60);
  assert.equal(parseDuration('2h30m'), 2 * 3600 + 30 * 60);
  assert.equal(parseDuration('1d'), 86400);
  assert.equal(parseDuration('45m'), 45 * 60);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('1 hour, 5 minutes'), 3600 + 300);
});

test('parseDuration treats a bare number as minutes', () => {
  assert.equal(parseDuration('90'), 90 * 60);
});

test('parseDuration rejects garbage and zero', () => {
  assert.throws(() => parseDuration('soon'), /Could not understand/);
  assert.throws(() => parseDuration('1x'), /Unknown time unit "x"/);
  assert.throws(() => parseDuration('0m'), /greater than zero/);
  assert.throws(() => parseDuration(''), /empty/);
});

test('parseDuration refuses misleading unit words instead of guessing', () => {
  // "1 month" must never silently become 1 minute for a scheduler.
  assert.throws(() => parseDuration('1 month'), /Unknown time unit "month"/);
  assert.throws(() => parseDuration('2 weeks'), /Unknown time unit "weeks"/);
  assert.equal(parseDuration('2 hours'), 7200);
  assert.equal(parseDuration('3 days'), 3 * 86400);
});

test('parseClockTime picks today when the time is still ahead', () => {
  const now = new Date('2026-07-16T10:00:00');
  const at = parseClockTime('14:30', now);
  assert.equal(at.getDate(), now.getDate());
  assert.equal(at.getHours(), 14);
  assert.equal(at.getMinutes(), 30);
});

test('parseClockTime rolls to tomorrow when the time already passed', () => {
  const now = new Date('2026-07-16T18:00:00');
  const at = parseClockTime('14:30', now);
  assert.equal(at.getDate(), now.getDate() + 1);
});

test('parseClockTime rejects invalid formats', () => {
  assert.throws(() => parseClockTime('25:00'), /not a valid time/);
  assert.throws(() => parseClockTime('14h30'), /not a valid time/);
  assert.throws(() => parseClockTime(''), /not a valid time/);
});

test('formatDuration renders compact durations', () => {
  assert.equal(formatDuration(9000), '2h 30m');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(90061), '1d 1h 1m');
});

test('timeAgo buckets by unit', () => {
  const now = new Date('2026-07-16T12:00:00');
  assert.equal(timeAgo(new Date('2026-07-16T11:59:30'), now), 'just now');
  assert.equal(timeAgo(new Date('2026-07-16T11:10:00'), now), '50m ago');
  assert.equal(timeAgo(new Date('2026-07-16T05:00:00'), now), '7h ago');
  assert.equal(timeAgo(new Date('2026-07-10T12:00:00'), now), '6d ago');
});

test('describeRunAt says "now" for imminent launches', () => {
  const now = new Date();
  assert.equal(describeRunAt(now, now), 'now');
  assert.match(describeRunAt(new Date(now.getTime() + 3600_000), now), /^in 1h /);
});

test('describeRunAt says how overdue a past launch is', () => {
  const now = new Date();
  assert.equal(describeRunAt(new Date(now.getTime() - 2 * 3600_000), now), 'due 2h ago');
  // Less than a minute late still reads as "now".
  assert.equal(describeRunAt(new Date(now.getTime() - 30_000), now), 'now');
});
