# Encrypted calls — design note (not yet built)

Item 9 of the feature batch. Deferred on purpose: a call feature that is
actually *reliable across the internet* needs one infrastructure decision
from you before it is worth writing, and the rest is a large piece of work.

## What the plan is

- **Media:** WebRTC (`getUserMedia` + `RTCPeerConnection`) in the Electron
  renderer. Audio first; video is the same pipeline with a second track.
- **Signalling:** no new server surface. The SDP offer/answer and ICE
  candidates ride inside the existing encrypted envelope as a new
  `kind: 'call'` body (`{ phase: 'offer'|'answer'|'ice'|'hangup', sdp,
  candidate }`), signed with the sender device's ML-DSA key and
  KEM-wrapped to the peer's devices exactly like a message. So call setup
  is authenticated and confidential with the same guarantees as chat.
- **Encryption of the media itself:** WebRTC media is always DTLS-SRTP
  encrypted hop-by-hop. To make it *end-to-end* and bound to the pqmsg
  identity, the DTLS certificate fingerprint each side generates is
  included in the signed `offer`/`answer` body and verified on receipt —
  so a malicious relay cannot substitute its own fingerprint. (Optionally,
  insertable streams / SFrame with a key derived from a fresh ML-KEM
  exchange for defence in depth.)
- **UI:** a call button next to the ⋯ menu in the thread header; an
  incoming-call banner; a compact in-call bar (mute, hang up, elapsed).

## The decision I need from you

NAT traversal. STUN alone (free, e.g. `stun:stun.l.google.com:19302`)
connects two peers only when at least one side has a permissive NAT —
fine on many home networks, fails on carrier-grade NAT, corporate
networks, and a lot of mobile. "Reliable across the internet" means a
**TURN relay** for the ~15–30% of pairs that cannot connect directly.

Options:

1. **Run our own TURN** (coturn on the same VPS or a second small one).
   ~$5/mo of infra, a bit of setup, we control it. Relayed calls use our
   bandwidth (audio is light, ~50–100 kbps per direction).
2. **A hosted TURN provider** (e.g. Cloudflare Calls / Twilio NTS /
   metered.ca). Less setup, a per-GB or per-minute bill, a third party in
   the relay path (media stays encrypted to them, but they see that a call
   happened and the traffic pattern).
3. **STUN only for v1**, accept that some pairs cannot connect, add TURN
   later. Ships sooner, but does not meet the "reliable across the
   internet" bar you set.

Tell me which of those you want and I will build it.
