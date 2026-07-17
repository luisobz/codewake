const UNIT_SECONDS = { d: 86400, h: 3600, m: 60, s: 1 };

// Full unit words only: matching just the first letter would silently turn
// "1 month" into one minute — unacceptable for a scheduler.
const UNIT_WORDS = new Map(Object.entries({
  d: 'd', day: 'd', days: 'd',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
}));

/**
 * Parse a human duration ("2h 30m", "45m", "1d", "90") into seconds.
 * A bare number is interpreted as minutes. Unknown units are an error.
 */
export function parseDuration(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) throw new Error('Duration is empty. Try something like "2h 30m".');
  if (/^\d+$/.test(raw)) return Number(raw) * 60;
  let total = 0;
  let unknownUnit = null;
  const leftovers = raw.replace(/(\d+)\s*([a-z]+)/g, (match, amount, word) => {
    const unit = UNIT_WORDS.get(word);
    if (!unit) {
      unknownUnit = word;
      return match;
    }
    total += Number(amount) * UNIT_SECONDS[unit];
    return '';
  });
  if (unknownUnit) {
    throw new Error(`Unknown time unit "${unknownUnit}". Use d, h, m or s, e.g. "2h 30m".`);
  }
  if (leftovers.replace(/[\s,]+/g, '') !== '') {
    throw new Error(`Could not understand "${text}". Try "2h 30m", "45m" or "90" (minutes).`);
  }
  if (total <= 0) throw new Error('Duration must be greater than zero.');
  return total;
}

/**
 * Parse a 24h clock time ("14:30") into the next Date it occurs
 * (today if still ahead, otherwise tomorrow).
 */
export function parseClockTime(text, now = new Date()) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? '').trim());
  if (!match) throw new Error(`"${text}" is not a valid time. Use 24h format, e.g. "14:30".`);
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || (seconds && !days && !hours)) parts.push(`${seconds}s`);
  return parts.join(' ');
}

export function timeAgo(date, now = new Date()) {
  const s = Math.max(0, (now.getTime() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function describeRunAt(runAt, now = new Date()) {
  const at = new Date(runAt);
  const delta = (at.getTime() - now.getTime()) / 1000;
  if (delta <= -60) return `due ${formatDuration(-delta)} ago`;
  if (delta < 60) return 'now';
  const clock = at.toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  });
  return `in ${formatDuration(delta)} (${clock})`;
}
