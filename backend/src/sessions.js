import { config } from './config.js';

const sessions = new Map();

export function getSession(id) {
  const now = Date.now();
  let s = sessions.get(id);
  if (!s) {
    s = { id, messages: [], lastUsed: now, turnTimestamps: [] };
    sessions.set(id, s);
  } else {
    s.lastUsed = now;
    if (!s.turnTimestamps) s.turnTimestamps = [];
  }
  return s;
}

// Phase 13 — per-session sliding-window rate check (200 turns / hour by
// default). Returns { allowed, retryAfterMs }. Side-effect: prunes expired
// timestamps from the session record. Increment via `recordTurn` AFTER the
// turn is accepted, so a rejected turn doesn't burn the budget.
export function checkSessionRate(id) {
  const s = getSession(id);
  const now = Date.now();
  const windowStart = now - config.sessionRateLimit.windowMs;
  // Prune old entries.
  while (s.turnTimestamps.length > 0 && s.turnTimestamps[0] < windowStart) {
    s.turnTimestamps.shift();
  }
  if (s.turnTimestamps.length >= config.sessionRateLimit.maxTurnsPerHour) {
    const oldest = s.turnTimestamps[0];
    const retryAfterMs = Math.max(0, oldest + config.sessionRateLimit.windowMs - now);
    return { allowed: false, retryAfterMs };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function recordTurn(id) {
  const s = getSession(id);
  s.turnTimestamps.push(Date.now());
}

export function appendTurn(id, role, content) {
  const s = getSession(id);
  s.messages.push({ role, content });
  const cap = config.session.maxTurns * 2;
  if (s.messages.length > cap) s.messages.splice(0, s.messages.length - cap);
}

export function sweep() {
  const cutoff = Date.now() - config.session.idleTimeoutMs;
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s.lastUsed < cutoff) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

export function startSessionSweeper(logger) {
  const t = setInterval(() => {
    const n = sweep();
    if (n) logger.debug({ removed: n, remaining: sessions.size }, 'session.sweep');
  }, config.session.sweepIntervalMs);
  t.unref();
  return t;
}

export function sessionCount() {
  return sessions.size;
}
