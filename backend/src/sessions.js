import { config } from './config.js';

const sessions = new Map();

export function getSession(id) {
  const now = Date.now();
  let s = sessions.get(id);
  if (!s) {
    s = { id, messages: [], lastUsed: now };
    sessions.set(id, s);
  } else {
    s.lastUsed = now;
  }
  return s;
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
