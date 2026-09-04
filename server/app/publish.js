'use strict';
/*
 * Auto-publish the running master-registry URL to a file in a GitHub repo
 * (default docs/servers.json) via the Contents API, so pqmsg clients that read
 * that file on startup always find the current registry — even though the
 * Cloudflare quick-tunnel URL changes on every restart.
 *
 * Needs a GitHub token with Contents: write on the repo (fine-grained PAT, one
 * repo, one permission). Stored in the Server app's config.
 */

async function publishServersJson({ token, repo, path: filePath, registryUrl }) {
  if (!token || !repo || !filePath || !registryUrl) throw new Error('missing token / repo / path / registryUrl');
  const base = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'pqmsg-server',
    'x-github-api-version': '2022-11-28',
  };

  // read the current file: need its sha, and preserve any hand-curated `servers`
  let sha = null;
  let servers = [];
  let comment;
  try {
    const res = await fetch(base, { headers });
    if (res.ok) {
      const cur = await res.json();
      sha = cur.sha;
      try {
        const j = JSON.parse(Buffer.from(cur.content || '', 'base64').toString('utf8'));
        if (Array.isArray(j.servers)) servers = j.servers;
        if (typeof j._comment === 'string') comment = j._comment;
        if (j.registry === registryUrl) return { ok: true, unchanged: true, sha };
      } catch {}
    } else if (res.status !== 404) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.message || `read HTTP ${res.status}`);
    }
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
  }

  const content = {
    _comment: comment || 'Auto-published by pqmsg Server — "registry" is the current master-registry URL clients discover from.',
    registry: registryUrl,
    servers,
  };
  const put = await fetch(base, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `pqmsg: registry -> ${registryUrl}`,
      content: Buffer.from(JSON.stringify(content, null, 2) + '\n').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  const j = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(j.message || `write HTTP ${put.status}`);
  return { ok: true, commit: j.commit && j.commit.sha };
}

module.exports = { publishServersJson };
