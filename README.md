# pqmsg

A post-quantum, end-to-end encrypted messenger. One server (`chat.jacknero.com`),
every account lives there — anyone anywhere can download the client and reach
anyone else who has. Ships as a desktop app for macOS, Windows and Linux.

Download: **https://jacknero2.github.io/pqmsg/** · Releases: **https://github.com/jacknero2/pqmsg/releases**

---

## What's in the box

| Component | Purpose |
|---|---|
| **pqmsg** (client, `client/`) | sign up, enroll a device, chat |
| **server** (`server/src`) | the one server every account lives on — accounts, message store, dashboard |

The client is unsigned (no paid code-signing certificate), so the OS asks you
to confirm the first launch — macOS: right-click → Open; Windows: *More info →
Run anyway*.

---

## Cryptography

Every message is sealed end-to-end. The server only ever stores and relays
ciphertext; it can see who is talking to whom and when, but not what is said.

| Layer | Scheme | Role |
|---|---|---|
| Key encapsulation | **ML-KEM-1024** (FIPS 203) | wraps a fresh session key to each recipient device |
| Signatures | **ML-DSA-87** (FIPS 204) | authenticates every message and device enrollment |
| Message body | **AES-256-GCM** | encrypts the payload under the per-message session key |
| KDF / hash | HKDF-SHA-256, SHA-256 | derives the wrap key from the KEM shared secret |

All of it is post-quantum or quantum-safe at these sizes, and NIST-standardized
for the asymmetric parts. Implemented with
[`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) and
Node's built-in `crypto` — pure JS, no native build step.

### Per-message flow

```
sender device                         server (ciphertext only)          each recipient device
─────────────                         ───────────────────────           ─────────────────────
K   = 32 random bytes
ct  = AES-256-GCM(K, plaintext)  ──►  append to the conversation    ──►  ML-KEM.decapsulate → ss
for each recipient device:            log; assign a monotonic            wrapKey = HKDF(ss, msgId)
  (kemCt, ss) = ML-KEM.encap(pk)      serverSeq; keep order.json         K  = AES-GCM⁻¹(wrapKey, wrappedK)
  wrapKey  = HKDF(ss, msgId)                                             plaintext = AES-GCM⁻¹(K, ct)
  wrappedK = AES-GCM(wrapKey, K)                                         verify ML-DSA sig, then ack delivery
sig = ML-DSA.sign(device key, …)  ──► verify sig vs the sender's
                                      IDS key before storing
```

Why not a homomorphic scheme (e.g. BFV): it is the wrong tool for transport —
multi-megabyte keys, no built-in authentication, orders of magnitude slower.
ML-KEM + ML-DSA is the construction Signal's PQXDH and Apple's iMessage PQ3 use.

---

## Design

### Identity & login

- Register with a **username, password and email**. Login is two steps:
  password → a 6-digit code emailed to that address → session token. Email
  delivery is SMTP by default (an account you already control, no third party
  in the code-delivery path) — with no SMTP or provider configured, the code
  is shown in the server console (dev fallback). If the host blocks outbound
  SMTP (common on cloud VPS providers as an anti-spam default — see DEPLOY.md),
  set `PQMSG_EMAIL_PROVIDER=resend` to send over Resend's HTTPS API instead,
  no code changes needed. "Remember this device" issues a signed 30-day token
  that skips the code on that machine, and the session itself is good for 7
  days idle — closing the app doesn't require logging in again.
- On first login the client generates its **ML-KEM-1024** and **ML-DSA-87**
  keypairs locally. The private keys never leave the device
  (`~/.pqmsg/<profile>/accounts/<username>/identity.json` in dev; the OS
  app-data dir when packaged). A single install can hold several accounts
  side by side, each in its own folder — switching accounts only ever logs
  out, it never deletes anything, and logging back into an account you've
  used on this device before (password + the emailed code) reuses that
  account's own device keys and cached message history rather than
  re-enrolling as a stranger.
- The public keys plus a self-signed *enrollment attestation* (proving the
  device holds the signing key and binding it to the username) are published to
  the server's **IDS** (Identity Directory Service). `GET /api/ids/:user` is
  public — clients read it without an account, to look someone up before
  messaging them.
- One account can enroll many devices. A message fans out to every device of
  every participant.
- Trust is **TOFU**: the first key seen for a user is trusted. Compare *safety
  numbers* out of band to detect a compromised server swapping keys.
- Messages are authenticated by the sender device's **ML-DSA signature over the
  envelope itself**, verified against that device's registered key — not just
  a bearer token, so it's non-repudiable per-message.

### Eventual consistency

Clients display messages optimistically, then every sync cycle re-pull a
trailing window and snap local order to the server's canonical `order.json`.
Not-yet-accepted sends are pinned to the tail. Outgoing bubbles are **light red**
until a recipient device acks delivery, then **gold**; failed sends turn red.
Delivery acks retry every cycle until confirmed (the server is idempotent).
A network failure (server unreachable, DNS trouble) never forces a re-login —
only an actual invalid/expired session does; anything else just retries with
backoff and keeps you signed in.

### Conversations

- **Direct messages & groups from one field** — type a name in "to:", press
  space/enter to turn it into a chip (blue while it resolves, gold when it
  matches a real account, red if not); one chip is a DM, two or more is a
  group. Autocomplete ranks people alphabetically, then by how recently you
  last talked. One DM per person — a repeat just opens the existing thread.
- **Group chats** — add/remove members at any time (only current members can
  change membership; new members see only post-join messages).
- **Conversation requests** — an incoming conversation shows "accept
  conversation from *name*?" with yes/no; nothing is pulled or acked until
  accepted, and decline stops it permanently.
- **Delete a chat** (your side only) — the peer keeps their copy; if they
  message you again it comes back as a fresh request with no old history.

### Messages

- **Edit** your own sent messages in place — no "edited" marker on either
  side; the bubble just goes red again until the edit is delivered.
- **React** with any emoji (quick picks + a free field); toggles, mirrored
  to everyone, never its own bubble.
- **Reply** — right-click a message or swipe it toward the centre with two
  fingers; the reply carries a "You said" / "@user said" quote.
- **Attachments** — send any file; images preview inline, everything else is
  a chip that saves to Downloads on click. All bytes ride inside the same
  encrypted envelope; the server only ever sees ciphertext.
- **Block / unblock** from the conversation's ⋯ menu — the blocked person is
  told in-chat and can read but not reply until unblocked.

### Account

Delete your account from Settings (typed confirmation) — removes it and its
data from the server and wipes it from this device. Operators can remove
accounts from the dashboard or with `npm run cleanup-users`.

### Version gates

Two, checked on startup and every 6 h: a **global floor** (`docs/version.json` —
raise `minSupported` to hard-block old clients) and a **per-server floor**
(`PQMSG_MIN_CLIENT`). Below the floor the client shows an unskippable "update
required" screen and refuses to sign in.

### Diagnostics

Clients best-effort report their own errors to `POST /api/diagnostics` on the
server. If the operator opted in (`PQMSG_SEND_DIAGNOSTICS=1` + a GitHub token),
the server relays them to a GitHub repo as deduped Issues (`shared/diagnostics.js`)
— repeated occurrences of the same bug comment on one issue instead of spamming
new ones, and anything secret-shaped is scrubbed before it ever leaves the box.
Otherwise it's just a line in the server's local activity log.

### Operator dashboard & usage analytics

`https://<your-server>/` is a login-gated console for whoever runs the server
— separate from normal user accounts.

- **Master login** — a single admin credential (password + emailed 2FA code),
  set up on first visit. The resulting session is a signed, 30-day token kept
  in the browser's `localStorage`, so it isn't re-entered every visit. The
  static `PQMSG_ADMIN_TOKEN` (`?admin=<token>`) still works too, for scripts.
  Forgot the password? "forgot password?" emails a reset code.
- **Console tab** — live connections, accounts/devices/safety numbers,
  a folder tree of conversations with ciphertext previews and raw envelopes,
  and an event ticker. Everything shown is ciphertext or metadata — message
  bodies are never readable here.
- **Analytics tab** (`GET /api/admin/analytics`) — total users, messages, and
  currently-online count, plus daily charts for the last 30 days: signups,
  active users, logins, messages sent, peak concurrent connections, and
  average session length. Signup counts are derived directly from account
  creation timestamps (accurate retroactively); everything else is tracked
  going forward by `server/src/analytics.js`, a small persisted daily-bucket
  counter file (`<dataDir>/analytics.json`) — not a raw event log, so it stays
  small forever and survives restarts.

---

## Functionality

- **Sign-up + email 2FA** — one form; login sends a code to your email (or
  shows it in the server console until SMTP is set). Trusted devices skip it
  for 30 days.
- **Direct messages & group chats**, with accept/decline on incoming requests.
- **Delivery receipts** — gold = delivered, light red = not yet.
- **Multi-device** — enroll the same account on several machines; each is a
  separate device in the IDS and receives every message.
- **Operator dashboard** — master login, a read-only console (conversations,
  ciphertext previews, raw envelopes, live connections, event ticker — it
  cannot read message bodies), and a usage-analytics tab (signups, DAU,
  messages, peak concurrency, session length).

---

## Run from source

For development. End users install the packaged client.

```bash
npm install
npm run e2e         # crypto + single-server round trip (DMs, groups, delivery, ordering)
npm run e2e:2fa     # email 2FA + trusted devices
npm run e2e:network # resume()/discovery resilience, concurrent writes, diagnostics, rate limits
npm run e2e:admin   # master login/2FA/forgot-password, session-token auth, usage analytics
```

| Command | Runs |
|---|---|
| `npm run server` | headless server on `:8787` (dashboard at `/`) |
| `PQMSG_PROFILE=alice npm run client` | a client (set distinct profiles to run several locally) |
| `npm run dist` | build a client installer for the current OS into `dist/` |

Useful env: `PQMSG_PUBLIC=1` (required for any internet-facing server),
`PQMSG_PUBLIC_URL` (the https URL clients use), `PQMSG_SMTP_*` (send real 2FA
emails via SMTP, the default) or `PQMSG_EMAIL_PROVIDER=resend` +
`PQMSG_RESEND_API_KEY`/`PQMSG_RESEND_FROM` (via Resend's HTTPS API instead,
for hosts that block outbound SMTP), `PQMSG_MIN_CLIENT`/`PQMSG_LATEST_CLIENT` (version floor),
`PQMSG_SEND_DIAGNOSTICS`/`PQMSG_DIAG_TOKEN`/`PQMSG_DIAG_REPO` (error reporting),
`PQMSG_MASTER_EMAIL` (who the dashboard's 2FA codes go to, default
`jnero@nd.edu`), `STORE_BACKEND=github` (commit the encrypted store to a repo
instead of local disk), `PQMSG_SERVER_URL` (client-side: which server to talk
to, for local dev — the packaged client always points at `chat.jacknero.com`).
See `.env.example`.

## Deploy

`DEPLOY.md` covers running it: a quick Cloudflare tunnel for local testing, and
the production path — `deploy/setup.sh` bootstraps a small VPS (Node + Caddy +
systemd) behind a real domain. Client releases are built and published
automatically by CI on every `v*` tag.

---

## Security notes (this is a prototype)

- The local keystore is plaintext on disk — a production build would wrap it with
  an OS keychain or a passphrase-derived key.
- 2FA proves control of the registered email, not much more; trusted-device
  tokens are stateless (no per-device revocation yet). Configure real SMTP before
  opening the server to others — the dev fallback shows codes to the operator.
- TOFU trust, no key-transparency log — a malicious server can serve a wrong
  key; the defense is out-of-band safety-number comparison.
- No forward secrecy / ratchet — compromising a device's ML-KEM secret exposes
  its past messages.
- Long-lived bearer tokens with no revocation list.
- Open registration; the IDS is a public username → key directory by design.
- Account emails and other profile fields are stored in plaintext at rest on
  the server (message content is not — see Cryptography above).
