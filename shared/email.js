'use strict';
/*
 * Outbound email for 2FA codes. Two real transports, chosen by
 * cfg.emailProvider ('smtp' | 'resend'), plus a "dev" fallback when neither
 * is configured (the code isn't sent but surfaced to the operator so
 * first-run setup and tests still work).
 *
 * SMTP is the default: it uses an email account you already control, with no
 * third party in the code-delivery path and no vendor lock-in. Resend (an
 * HTTPS API) is there specifically for hosts that block outbound SMTP ports
 * (common on cloud VPS providers as an anti-spam default) — set
 * PQMSG_EMAIL_PROVIDER=resend to use it instead, no code changes needed.
 */
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {}

// A connection that can't complete (e.g. a provider silently dropping
// outbound port 587, or a stalled HTTPS request) would otherwise hang forever
// with no error. Fail fast instead so the caller gets a real error, not an
// infinite spinner — applies to both transports below.
const EMAIL_TIMEOUT_MS = 10_000;

function createSmtpMailer(cfg) {
  const from = cfg.smtpFrom || cfg.smtpUser || 'pqmsg <no-reply@pqmsg.local>';
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: Number(cfg.smtpPort) || 587,
    secure: !!cfg.smtpSecure || Number(cfg.smtpPort) === 465,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    connectionTimeout: EMAIL_TIMEOUT_MS,
    greetingTimeout: EMAIL_TIMEOUT_MS,
    socketTimeout: EMAIL_TIMEOUT_MS,
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

function createResendMailer(cfg) {
  const from = cfg.resendFrom || cfg.smtpFrom || 'pqmsg <onboarding@resend.dev>';
  const apiKey = cfg.resendApiKey;
  return {
    mode: 'resend',
    from,
    async send({ to, subject, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
        signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `resend HTTP ${res.status}`);
      }
    },
    async verify() {
      // Resend has no dedicated verify endpoint; a bad key surfaces on first send.
      return apiKey ? { ok: true } : { ok: false, error: 'no PQMSG_RESEND_API_KEY set' };
    },
  };
}

function createMailer(cfg = {}) {
  const provider = (cfg.emailProvider || 'smtp').toLowerCase();
  if (provider === 'resend' && cfg.resendApiKey) return createResendMailer(cfg);
  if (provider !== 'resend' && cfg.smtpHost && nodemailer) return createSmtpMailer(cfg);
  // fall through: requested provider isn't actually configured — try the other one
  // rather than silently going to dev mode when the operator clearly meant to send real mail
  if (cfg.resendApiKey) return createResendMailer(cfg);
  if (cfg.smtpHost && nodemailer) return createSmtpMailer(cfg);
  return {
    mode: 'dev',
    from: cfg.smtpFrom || cfg.resendFrom || 'pqmsg <no-reply@pqmsg.local>',
    async send() {
      /* no transport — caller surfaces the code itself */
    },
    async verify() {
      return { ok: false, error: 'no email provider configured (dev mode)' };
    },
  };
}

const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  if (!d) return '••••';
  return (u.length <= 2 ? u[0] || '•' : u.slice(0, 2)) + '•••@' + d;
};

module.exports = { createMailer, maskEmail };
