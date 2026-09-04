'use strict';
/*
 * Best-effort error reporting to a GitHub repo the operator already controls
 * (PQMSG_DIAG_TOKEN / PQMSG_DIAG_REPO — a fine-grained PAT with Issues: write).
 * Dedupes by a short fingerprint of (component, kind, message) embedded in the
 * issue title, so repeated occurrences of the same underlying bug comment on
 * one issue instead of spamming new ones. Never throws — a failed report is
 * dropped silently so it can never take down the thing it's reporting on, and
 * never includes anything that looks like a secret.
 */
const crypto = require('crypto');

const _recent = new Map(); // fingerprint -> last-attempted-at ms
const COOLDOWN_MS = 10 * 60 * 1000;
const SECRET_KEY_RE = /pass|token|secret|salt|hash|key|smtp|auth/i;

function fingerprint({ component, kind, message }) {
  const s = `${component}|${kind}|${String(message || '').slice(0, 200)}`;
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}

function scrub(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (SECRET_KEY_RE.test(k)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

/**
 * @param {{token:string, repo:string, component:string, kind:string, message:string, stack?:string, context?:object}} p
 * @returns {Promise<{ok:boolean, issue?:number, mode?:string, reason?:string}>}
 */
async function reportIssue({ token, repo, component, kind, message, stack, context }) {
  if (!token || !repo) return { ok: false, reason: 'not configured' };
  const fp = fingerprint({ component, kind, message });
  const now = Date.now();
  const last = _recent.get(fp);
  if (last && now - last < COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
  _recent.set(fp, now);
  if (_recent.size > 500) _recent.delete(_recent.keys().next().value);

  const safeMessage = String(message || kind || 'unknown error').slice(0, 500);
  const title = `[diag ${fp}] ${component}: ${safeMessage.slice(0, 80)}`;
  const safeContext = scrub(context);
  const body = [
    `**component:** ${component}`,
    `**kind:** ${kind || ''}`,
    `**message:** ${safeMessage}`,
    Object.keys(safeContext).length ? `**context:**\n\`\`\`json\n${JSON.stringify(safeContext, null, 2)}\n\`\`\`` : '',
    stack ? `**stack:**\n\`\`\`\n${String(stack).slice(0, 3000)}\n\`\`\`` : '',
    '',
    `_fingerprint: ${fp} · reported ${new Date(now).toISOString()}_`,
  ].filter(Boolean).join('\n\n');

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'pqmsg-diagnostics',
  };
  try {
    const q = encodeURIComponent(`repo:${repo} in:title "[diag ${fp}]" is:issue`);
    const searchRes = await fetch(`https://api.github.com/search/issues?q=${q}`, { headers });
    const searchJ = await searchRes.json().catch(() => ({}));
    const existing = searchRes.ok && Array.isArray(searchJ.items) ? searchJ.items[0] : null;

    if (existing) {
      const cRes = await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: `Seen again at ${new Date(now).toISOString()}.\n\n${body}` }),
      });
      if (!cRes.ok) return { ok: false, reason: 'HTTP ' + cRes.status };
      return { ok: true, issue: existing.number, mode: 'commented' };
    }
    const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, body, labels: ['auto-diagnostic'] }),
    });
    const createJ = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return { ok: false, reason: createJ.message || 'HTTP ' + createRes.status };
    return { ok: true, issue: createJ.number, mode: 'created' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { reportIssue, fingerprint, scrub };
