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

  // --- public directory listing (see registry/) ---
  serverName: process.env.PQMSG_SERVER_NAME || '',
  serverDescription: process.env.PQMSG_SERVER_DESCRIPTION || '',
  serverRegion: process.env.PQMSG_SERVER_REGION || '',
  serverPublicUrl: process.env.PQMSG_PUBLIC_URL || '', // the https URL clients actually use (tunnel / domain)
  registryUrl: process.env.PQMSG_REGISTRY_URL || '',
  announce: /^(1|true|yes)$/i.test(process.env.PQMSG_ANNOUNCE || ''),

  // --- client version gate: served at /api/serverinfo, enforced by clients ---
  minClient: process.env.PQMSG_MIN_CLIENT || '', // clients below this are hard-blocked from this server
  latestClient: process.env.PQMSG_LATEST_CLIENT || '', // newest known; clients below get a soft "update available"
  clientDownloadUrl: process.env.PQMSG_DOWNLOAD_URL || 'https://jacknero2.github.io/pqmsg/',

  // --- email 2FA on login (SMTP via nodemailer; dev fallback if unset) ---
  smtpHost: process.env.PQMSG_SMTP_HOST || '',
  smtpPort: process.env.PQMSG_SMTP_PORT || '587',
  smtpUser: process.env.PQMSG_SMTP_USER || '',
  smtpPass: process.env.PQMSG_SMTP_PASS || '',
  smtpFrom: process.env.PQMSG_SMTP_FROM || '',
  smtpSecure: /^(1|true|yes)$/i.test(process.env.PQMSG_SMTP_SECURE || ''),
  trustedDeviceDays: parseInt(process.env.PQMSG_TRUST_DAYS || '30', 10),

  // --- master registry: this server can host the directory itself ---
  masterEmail: (process.env.PQMSG_MASTER_EMAIL || 'jnero@nd.edu').toLowerCase(),

  // federation SSRF knobs (also read directly by federation.js / registry)
  fedAllowInsecure: /^(1|true|yes)$/i.test(process.env.PQMSG_FED_ALLOW_INSECURE || ''),
  fedTrustAll: /^(1|true|yes)$/i.test(process.env.PQMSG_FED_TRUST_ALL || ''),
};

module.exports = { config };
