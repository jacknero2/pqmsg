# pqmsg — post-quantum end-to-end messenger

An iMessage-style encrypted messaging app: automatic device enrollment, an
identity directory service (IDS) of per-device public keys, conversations stored
as folders of ciphertext, delivery receipts, and an eventually-consistent
ordering model. Ships with an Electron client and a read-only server console.

## Cryptography

| Layer | Scheme | Why |
|---|---|---|
| Key encapsulation | **ML-KEM-1024** (FIPS 203, "Kyber") | wraps a fresh session key to each recipient device |
| Signatures | **ML-DSA-87** (FIPS 204, "Dilithium") | authenticates every message + the enrollment attestation |
| Message body | **AES-256-GCM** | already quantum-safe at 256-bit; keyed per-message |
| KDF / hash | HKDF-SHA-256, SHA-256 | derive the wrap key from the KEM shared secret |

Implemented with [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum)
(pure JS, no native build) + Node's built-in `crypto`.

### Why not BFV?

BFV is a **fully homomorphic** encryption scheme — multi-megabyte keys, no
built-in authentication, and orders of magnitude slower. It is meant for
computing on ciphertext, not transporting messages. ML-KEM + ML-DSA is the
construction Signal's PQXDH and Apple's iMessage PQ3 actually use. If you later
want "server computes on encrypted data" features, that is where a scheme like
BFV would come back in.

### Per-message flow

```
sender device                          server (sees only ciphertext)          recipient device(s)
─────────────                          ───────────────────────────           ───────────────────
K  = random 32 bytes
ct = AES-256-GCM(K, plaintext)   ──►   store envelope in
for each recipient device:             conversations/<id>/messages/           ML-KEM.decapsulate → ss
  (kemCt, ss) = ML-KEM.encap(pk)       NNN-msg_….json                         wrapKey = HKDF(ss, msgId)
  wrapKey = HKDF(ss, msgId)            append msgId to order.json             K  = AES-GCM⁻¹(wrapKey, wrappedK)
  wrappedK = AES-GCM(wrapKey, K)                                              plaintext = AES-GCM⁻¹(K, ct)
sig = ML-DSA.sign(everything)    ──►   verify sig vs sender's IDS key    ──►  verify sig, then POST …/delivered
```

## Architecture

```
pqmsg/
├── shared/                 crypto + protocol + storage, used by client AND server
│   ├── crypto.js           ML-KEM / ML-DSA / AES-GCM envelope build/open/verify
│   ├── protocol.js         scrypt passwords, HMAC bearer tokens
│   └── store/              storage abstraction
│       ├── local.js        filesystem backend  (default)
│       └── github.js       GitHub-repo backend (STORE_BACKEND=github)
├── server/
│   ├── src/index.js        HTTP API + WebSocket presence/wake + dashboard host
│   └── public/             the server console (ciphertext-only view)
├── client/                 Electron app
│   ├── main/engine.js      identity, key storage, background sync loop, local
│   │                       DECRYPTED conversation store, delivery/ordering logic
│   ├── main/index.js       Electron main + IPC
│   └── renderer/           the chat UI
└── scripts/e2e.js          full no-Electron end-to-end test
```

### Client responsibilities (from the spec)

1. **Enroll** — on first login the client generates its ML-KEM + ML-DSA keypairs
   locally. The **private keys never leave the machine** (`~/.pqmsg/<profile>/identity.json`).
   The public keys + a self-signed attestation go to the server IDS, tagged with a
   device id derived from the signing key. One account can enroll many devices.
2. **Send** — per-message AES-256-GCM session key, wrapped to every recipient
   device with ML-KEM, signed with ML-DSA. Sender's *own other* devices are
   included so multi-device stays in sync.
3. **Find people** — type a username → `GET /api/ids/:username` → all their device
   public keys + a safety number. Cached, and re-checked; a changed safety number
   raises a warning in the console.
4. **Eventual consistency** — a background loop (every `syncIntervalMs`, default
   3 s; also nudged by a WebSocket `wake`) pulls each conversation, decrypts new
   messages into the local **plaintext** store, and **snaps local message order to
   the server's canonical `order.json`**. Messages you sent that the server hasn't
   accepted yet stay pinned to the bottom as "pending".
5. **Delivery receipts** — after decrypting, a device POSTs `…/delivered`. The
   sender's next sync sees the ack and the bubble turns **gold**. Until then it is
   **light red** (`pending` = queued locally, `sent` = on the server but nobody has
   fetched it). Failed sends (bad signature, etc.) go red with a `✗`.

### Server responsibilities

- Hosts the **IDS** and the **accounts** (scrypt-hashed passwords, HMAC tokens).
- Stores each conversation as a folder of ciphertext envelopes, numbered in
  ingest order; maintains `order.json` as the canonical total order.
- Verifies every envelope's ML-DSA signature against the sender's enrolled key
  before storing it.
- WebSocket: tracks who is connected, pushes `wake` hints to participants.
- Serves the **dashboard** — folders, ciphertext previews, raw envelopes,
  live connection list, event ticker. It **cannot read message bodies**.

## Running it

```bash
cd pqmsg
npm install
```

### 1. Server

```bash
npm run server
```

Prints the dashboard URL (`http://localhost:8787/`) and, when no
`PQMSG_ADMIN_TOKEN` is set, an admin token for opening the dashboard from another
machine as `http://<host>:8787/?admin=<token>`.

### 2. Clients

Each client is a "profile" = one device identity = one account. Run two on one
machine:

```bash
PQMSG_PROFILE=alice npm run client
PQMSG_PROFILE=bob   npm run client
```

In each window: enter the server URL, pick a username + password, hit
**register** once, then **login & enroll**. Type the other person's username in
the `to:` field to start chatting.

Useful env vars: `PQMSG_SERVER`, `PQMSG_SYNC_MS`, `PQMSG_DATA_DIR`.

### 3. Test without the GUI

```bash
npm run e2e
```

Boots the server in-process, drives two client engines, and checks the crypto
round trip, signature verification, delivery acks (red → gold), and that both
replicas converge to the server's message order.

### Testing with another person over a network

The server binds `0.0.0.0`. Expose it with e.g. `ngrok http 8787` (or Tailscale)
and give the other person the URL as their server address. Set
`PQMSG_ADMIN_TOKEN` if you want to reach the dashboard remotely.

## GitHub storage backend

Set in `server/.env`:

```
STORE_BACKEND=github
GITHUB_TOKEN=ghp_xxx          # a PAT with repo contents write
GITHUB_REPO=your-user/pqmsg-db
GITHUB_BRANCH=main
```

Now every account, device key, encrypted message and `order.json` update is a
commit. Canonical ordering == commit order. Caveats: the authenticated API is
5000 req/hr, so keep sync intervals ≥ 3 s and the number of active conversations
small while testing; concurrent writers occasionally 409 and are retried. Server
secrets are kept in `~/.pqmsg-server-secret.json`, never committed.

## Security notes / limitations (prototype)

- The local keystore (`identity.json`) is plaintext on disk. A real build would
  wrap it with an OS keychain or a passphrase-derived key.
- Trust is **TOFU**: the first key seen for a user is trusted. Compare safety
  numbers out of band to detect a malicious IDS. There is no key-transparency log.
- No forward secrecy / ratchet yet — it's KEM-per-message, not Double-Ratchet.
  Compromising a device's ML-KEM secret key exposes past messages to that device.
- No group-key management beyond "encrypt to every member's every device".
- Tokens are long-lived HMAC bearer tokens; there's no revocation list.
