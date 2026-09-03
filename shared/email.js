'use strict';
/*
 * Outbound email for 2FA codes. Uses SMTP via nodemailer when configured;
 * otherwise runs in "dev" mode where the code is not sent but surfaced to the
 * operator (server log + dashboard) so first-run setup and tests still work.
 */
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {}

function createMailer(cfg = {}) {
  const from = cfg.smtpFrom || cfg.smtpUser || 'pqmsg <no-reply@pqmsg.local>';
  if (cfg.smtpHost && nodemailer) {
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: Number(cfg.smtpPort) || 587,
      secure: !!cfg.smtpSecure || Number(cfg.smtpPort) === 465,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    });
    return {
      mode: 'smtp',
      from,
      async send({ to, subject, text }) {
        await transport.sendMail({ from, to, subject, text });
      },
      async verify() {
        try {
          await transport.verify();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    };
  }
  return {
    mode: 'dev',
    from,
    async send() {
      /* no transport — caller surfaces the code itself */
    },
    async verify() {
      return { ok: false, error: 'no SMTP configured (dev mode)' };
    },
  };
}

const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  if (!d) return '••••';
  return (u.length <= 2 ? u[0] || '•' : u.slice(0, 2)) + '•••@' + d;
};

module.exports = { createMailer, maskEmail };
