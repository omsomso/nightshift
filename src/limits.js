// Subscription usage limits. When Claude or Codex reports one, the plan waits for the reset
// instead of failing the task. The CLIs word it differently across versions, so this reads
// the reset time from whichever form is present and falls back to a short retry.
const limitText = /usage limit|rate limit|limit reached|hit your (?:usage )?limit|out of (?:credits|usage)/i;
export const fallbackWaitMinutes = 30;
// A little after the reported reset, so the first turn does not land on the boundary.
const marginMs = 2 * 60_000;

// Returns { resetsAt: ISO string, known: boolean } for a usage-limit message, or null.
export function parseUsageLimit(text, now = new Date()) {
  const message = String(text ?? '');
  if (!limitText.test(message)) return null;
  const at = date => ({ resetsAt: new Date(date.getTime() + marginMs).toISOString(), known: true });
  // "Claude AI usage limit reached|1760000000" (epoch seconds).
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return at(new Date(Number(epoch[1]) * 1000));
  // "try again in 2 hours 5 minutes", "in 45 minutes".
  const span = /\bin\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(message);
  if (span && (span[1] || span[2])) return at(new Date(now.getTime() + ((Number(span[1] ?? 0) * 60) + Number(span[2] ?? 0)) * 60_000));
  // "resets 3pm", "resets at 11:30 PM", "try again at 15:05".
  const clock = /(?:resets?|again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (clock) {
    let hours = Number(clock[1]) % 24;
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return at(next);
  }
  return { resetsAt: new Date(now.getTime() + fallbackWaitMinutes * 60_000).toISOString(), known: false };
}

// Epoch seconds or milliseconds, or an ISO string, from a structured rate-limit event.
export function resetFromEvent(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  if (Number.isNaN(date.getTime()) || date <= now) return null;
  return { resetsAt: new Date(date.getTime() + marginMs).toISOString(), known: true };
}
