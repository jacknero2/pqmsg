# Deploying the pqmsg server

There is one production server: `chat.jacknero.com`. The packaged client
always points there (`client/main/engine.js`'s `SERVER_URL`), so end users
never configure anything — download, sign up, done. This file is for
whoever operates that server (or a dev/test server of their own).

---

## A. Local dev/testing — a quick Cloudflare tunnel

Useful for testing a server from a phone or another machine without deploying
anything. Not for production — the hostname changes every restart, and a
[client override](#pointing-a-dev-client-at-it) is required since the packaged
app doesn't have a server picker.

```bash
brew install cloudflared        # once

# terminal 1 — run the server in PUBLIC mode with a pinned admin token
cd pqmsg
PQMSG_PUBLIC=1 PQMSG_ADMIN_TOKEN=$(openssl rand -hex 16) npm run server
#   ^ note the "admin token:" and "dashboard:" lines it prints

# terminal 2 — open the tunnel
cloudflared tunnel --url http://localhost:8787
#   prints:  https://<random-words>.trycloudflare.com
```

Dashboard: `https://<random-words>.trycloudflare.com/?admin=<the token>`.

`PQMSG_PUBLIC=1` is **required** for any internet-facing run. Behind a tunnel
every request looks like `127.0.0.1`, so without it the admin dashboard would
be open to the world.

#### Pointing a dev client at it

Run the client from source with `PQMSG_SERVER_URL` set to your tunnel/test
URL — the packaged app has no server field, this env var is the only way to
override it:

```bash
PQMSG_SERVER_URL=https://<random-words>.trycloudflare.com PQMSG_PROFILE=test npm run client
```

---

## B. Production — an always-on VPS behind a real domain

This is how `chat.jacknero.com` runs. Immune to a laptop sleeping, campus/
corporate DNS blocking `*.trycloudflare.com`, and quick-tunnel rotation — a
real IP, a real domain, always on. ~100 concurrent users is a single small
instance — no load balancer, no Redis, no autoscaling.

**`deploy/setup.sh` does steps 2–4 for you** on a fresh Ubuntu/Debian box
(installs Node 20 + Caddy, clones the repo, creates a `pqmsg` systemd service,
writes a Caddyfile, pins an admin token):

1. Provision a small VM (Oracle Cloud "Always Free" ARM, or a $5–6/mo
   Hetzner/DigitalOcean box — 1 vCPU / 1 GB RAM / a few GB disk is plenty) and
   point a DNS **A record** for your hostname at its public IP.
2. Edit `deploy/pqmsg.env.example` → hostname (`PQMSG_PUBLIC_URL`), server name,
   optional SMTP, before running the script (or edit `deploy/pqmsg.env` after
   the first run and re-run the script).
3. SSH in and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/jacknero2/pqmsg/main/deploy/setup.sh | sudo bash
   ```
4. It prints the dashboard URL (`https://<host>/?admin=<token>`) when done.
   `journalctl -u pqmsg -f` for logs; `systemctl restart pqmsg` after a
   `git -C /opt/pqmsg pull` + `npm ci --omit=dev` to deploy an update.

If the hostname is `chat.jacknero.com`, packaged clients already point there —
nothing else to configure. Deploying under a different hostname means also
changing `SERVER_URL` in `client/main/engine.js` and cutting a new client release.

### A note on email (2FA codes) on a cloud VPS

Most cloud VPS providers (DigitalOcean, Hetzner, AWS, etc.) **block outbound
SMTP ports by default** as an anti-spam measure — if you configure
`PQMSG_SMTP_*`, requests that try to send a 2FA code will hang and time out
rather than fail cleanly. Check before you're surprised by it:

```bash
timeout 10 bash -c "echo > /dev/tcp/smtp.gmail.com/587" && echo CONNECTED || echo "BLOCKED/TIMED OUT"
```

If it's blocked, either ask your provider's support to lift the restriction
for your account (usually resolved within a day), or skip the wait entirely
by setting `PQMSG_EMAIL_PROVIDER=resend` — an HTTPS API (port 443, never
port-blocked) that works immediately. See `.env.example` for the Resend
variables.

### Storage on a cloud host

- Default `local` backend writes to `PQMSG_DATA_DIR` (default `./server-data`).
  Keep that on the instance's persistent disk / a mounted volume.
- **Do not use `STORE_BACKEND=github` with many clients** — 100 clients polling
  every few seconds blows past GitHub's 5000 req/hour. It only suits a handful of
  slow-polling testers.

### Before opening registration to the public

- Pin `PQMSG_ADMIN_TOKEN` (don't rely on the auto one — it regenerates if
  `server-data` is wiped).
- Add rate limiting on `/api/auth/register` and message POSTs; consider invite
  codes. The IDS is a public username → key directory by design.
