// Tokens a plan has used, for its limit and the owner's view: new input plus output.
// Cache re-reads (the same context read again on every turn) are left out: they grow with
// every turn of a long session, cost little, and made long plans trip their limit early.
export const freshTokens = detail => {
  const t = detail?.tokens ?? {};
  return Math.max(0, (Number(t.input) || 0) - (Number(t.cachedInput) || 0)) + (Number(t.output) || 0);
};

export const planTokens = events => events.filter(e => e.type === 'provider:usage').reduce((sum, e) => sum + freshTokens(e.detail), 0);
