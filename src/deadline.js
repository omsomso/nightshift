// A turn's time limit that can change while the turn runs: `limit` is milliseconds or a
// function returning them (the plan's current time per turn). Calls `expire(ms)` once.
export function deadline(limit, expire) {
  const started = Date.now();
  const current = () => (typeof limit === 'function' ? limit() : limit);
  const timer = setInterval(() => {
    const ms = current();
    if (Date.now() - started >= ms) { clearInterval(timer); expire(ms); }
  }, Math.max(20, Math.min(1000, current() / 10)));
  return () => clearInterval(timer);
}
