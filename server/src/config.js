'use strict';
const fs = require('fs');
const path = require('path');

/* Tiny .env loader (no dependency). Looks for pqmsg/server/.env then pqmsg/.env */
function loadDotenv() {
  for (const p of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadDotenv();

const config = {
  port: parseInt(process.env.PQMSG_PORT || '8787', 10),
  host: process.env.PQMSG_HOST || '0.0.0.0',
  backend: (process.env.STORE_BACKEND || 'local').toLowerCase(),
  dataDir: process.env.PQMSG_DATA_DIR || path.join(__dirname, '..', '..', 'server-data'),
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  adminToken: process.env.PQMSG_ADMIN_TOKEN || '', // extra admin token (an auto one always exists too)
  // set PQMSG_PUBLIC=1 for any internet-facing deployment (tunnel, cloud): it
  // disables the "loopback requests skip the admin token" bypass, which is unsafe
  // behind a proxy/tunnel because every request then originates from 127.0.0.1.
  public: /^(1|true|yes)$/i.test(process.env.PQMSG_PUBLIC || ''),
};

module.exports = { config };
