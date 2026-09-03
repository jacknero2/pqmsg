# pqmsg

A post-quantum, end-to-end encrypted messenger you can self-host. Federated:
independent servers interconnect, so a user on one server can DM or group-chat
anyone on any other server. Ships as desktop apps for macOS, Windows and Linux.

Download: **https://jacknero2.github.io/pqmsg/** · Releases: **https://github.com/jacknero2/pqmsg/releases**

---

## What's in the box

| Component | Who runs it | Purpose |
|---|---|---|
| **pqmsg** (client) | every user | sign up, enroll a device, chat |
| **pqmsg Server** | anyone who wants to host | runs a server + a one-click public tunnel; can list itself in a registry |
| **registry** (`registry/`) | optional, one per community | a directory servers announce to, so clients auto-discover them |

The client and server apps are unsigned (no paid code-signing certificate), so
the OS asks you to confirm the first launch — macOS: right-click → Open;
Windows: *More info → Run anyway*.

---

## Cryptography

Every message is sealed end-to-end. The server only ever stores and relays
ciphertext; it can see who is talking to whom and when, but not what is said.

| Layer | Scheme | Role |
|---|---|---|
| Key encapsulation | **ML-KEM-1024** (FIPS 203) | wraps a fresh session key to each recipient device |
| Signatures | **ML-DSA-87** (FIPS 204) | authenticates every message, enrollment, and cross-server request |
| Message body | **AES-256-GCM** | encrypts the payload under the per-message session key |
| KDF / hash | HKDF-SHA-256, SHA-256 | derives the wrap key from the KEM shared secret |
| Server identity | **Ed25519** | signs a server's registry announcements |

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
  password → a 6-digit code emailed to that address → session token. SMTP is
  configured on the server (via env or the Server app); with no SMTP the code is
  shown in the server console (dev fallback). "Remember this device" issues a
  signed 30-day token that skips the code on that machine.
- On first login the client generates its **ML-KEM-1024** and **ML-DSA-87**
  keypairs locally. The private keys never leave the device
  (`~/.pqmsg/<profile>/identity.json` in dev; the OS app-data dir when packaged).
- The public keys plus a self-signed *enrollment attestation* (proving the
  device holds the signing key and binding it to the username) are published to
  the server's **IDS** (Identity Directory Service). `GET /api/ids/:user` is
  public — federated peers and clients read it without an account.
- One account can enroll many devices. A message fans out to every device of
  every participant.
- Trust is **TOFU**: the first key seen for a user is trusted. Compare *safety
  numbers* out of band to detect a malicious server swapping keys.

### Federation — per-conversation home server

Users are addressed as **`user@server`** (the server part is an origin URL).
There is no central hub; instead:

- Each conversation has one **home server**, chosen deterministically as the
  lexicographically-smallest participant server (DMs) or minted at creation and
  fixed (groups). It is the single writer of that conversation's log — so the
  simple `order.json` model survives federation, no CRDT needed.
- Every participant's client — wherever their account lives — reads and writes
  that conversation against its home server. A message sent to the wrong server
  is bounced with `421` and the correct home address; the client retries.
- **Key discovery is federated**: to message `bob@srv2`, the client (and the home
  server, to verify signatures) fetches `https://srv2/api/ids/bob`, cached with a
  short TTL.
- **Foreign writes** need no account on the home server: the ML-DSA signature on
  the envelope *is* the authentication. The home server resolves the sender's
  IDS from the sender's own server and verifies.
- **Foreign reads** are authenticated by a short-lived `X-PQMSG-Auth` header —
  an ML-DSA signature over a canonical challenge, verified against the caller's
  IDS. Non-participants are refused.
- When a conversation is created, its home server notifies each remote
  participant's server (`POST /api/federated/notify`), which records a pointer so
  the conversation appears in that user's inbox. Clients poll `/api/inbox` on
  their **own** server only.

### Eventual consistency

Clients display messages optimistically, then every sync cycle re-pull a
trailing window and snap local order to the home server's canonical `order.json`.
Not-yet-accepted sends are pinned to the tail. Outgoing bubbles are **light red**
until a recipient device acks delivery, then **gold**; failed sends turn red.
Delivery acks retry every cycle until confirmed (the server is idempotent).

### Server discovery & the registry

- The client's login screen shows a **server picker** merged from a static seed
  (`docs/servers.json`), a live registry, and URLs the user pins — each probed
  for liveness and latency.
- The **registry** is a directory servers announce to (signed Ed25519
  announcements, first-come name ownership, a URL callback check, stale entries
  dropped). Run it standalone (`npm run registry`) **or** let a server host it:
  a **master user** (`PQMSG_MASTER_EMAIL`, default `jnero@nd.edu`) sets a
  password, verifies it by email code, and the server then serves the registry
  at `https://<server>/registry` — no separate service to deploy. The server
  lists itself and can curate the entry list from the Server app.

### Version gates

Two, checked on startup and every 6 h: a **global floor** (`docs/version.json` —
raise `minSupported` to hard-block old clients) and a **per-server floor**
(`PQMSG_MIN_CLIENT`). Below the floor the client shows an unskippable "update
required" screen and refuses to sign in.

---

## Functionality

- **Sign-up + email 2FA** — one form; login sends a code to your email
  (or shows it in the server console until SMTP is set). Trusted devices skip it
  for 30 days. Keys are generated and published in the background.
- **Direct messages**, including across servers — address anyone as `user@server`.
- **Group chats**, members freely spanning servers; add/remove members at any
  time (only current members can change membership; new members see only
  post-join messages).
- **Conversation requests** — an incoming conversation shows "accept conversation
  from *name*?" with yes/no; nothing is pulled or acked until accepted, and
  decline stops it permanently.
- **Delivery receipts** — gold = delivered, light red = not yet.
- **Multi-device** — enroll the same account on several machines; each is a
  separate device in the IDS and receives every message.
- **Read-only server console** — folder tree of conversations, ciphertext
  previews, raw envelopes, live connection list, event ticker. It cannot read
  message bodies.
- **Cloudflare tunnel** built into the Server app — one click yields a public
  `https://…` address with no router configuration; works behind NAT / CGNAT /
  restrictive networks.

---

## Run from source

For development. End users install the packaged apps.

```bash
npm install
npm run e2e            # crypto + single-server round trip
npm run e2e:registry   # server directory + client discovery + version gates
npm run e2e:federation # cross-server DMs, groups, membership, auth boundary
npm run e2e:2fa        # email 2FA + trusted devices + master-registry mode
```

| Command | Runs |
|---|---|
| `npm run server` | headless server on `:8787` |
| `npm run server:app` | the Server control-panel app |
| `npm run registry` | the directory service on `:8788` |
| `PQMSG_PROFILE=alice npm run client` | a client (set distinct profiles to run several locally) |
| `npm run dist` | build installers for the current OS into `dist/` |

Useful env: `PQMSG_PUBLIC=1` (required for any internet-facing server),
`PQMSG_PUBLIC_URL` (the https URL clients use), `PQMSG_SMTP_*` (send real 2FA
emails), `PQMSG_MASTER_EMAIL` (who unlocks the built-in registry),
`PQMSG_SERVER_NAME` + `PQMSG_REGISTRY_URL` + `PQMSG_ANNOUNCE=1` (list in a
registry), `PQMSG_MIN_CLIENT` (version floor), `STORE_BACKEND=github` (commit the encrypted
store to a repo instead of local disk). See `.env.example`.

## Deploy

`DEPLOY.md` covers the two paths: the built-in Cloudflare tunnel (server on your
own machine), or a small always-on cloud VM with Caddy for TLS. Releases are
built and published automatically by CI on every `v*` tag.

---

## Security notes (this is a prototype)

- The local keystore is plaintext on disk — a production build would wrap it with
  an OS keychain or a passphrase-derived key.
- 2FA proves control of the registered email, not much more; trusted-device
  tokens are stateless (no per-device revocation yet). Configure real SMTP before
  opening a server to others — the dev fallback shows codes to the operator.
- TOFU trust, no key-transparency log — a malicious server or registry can serve
  a wrong key; the defense is out-of-band safety-number comparison.
- No forward secrecy / ratchet — compromising a device's ML-KEM secret exposes
  its past messages.
- Long-lived bearer tokens with no revocation list.
- Open registration; the IDS is a public username → key directory by design.
- A conversation is unavailable while its home server is down, even if the
  participants are online.
