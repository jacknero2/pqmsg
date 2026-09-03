# Deploying pqmsg so people elsewhere can connect

Clients talk to **one server**; there is no client-to-client path. To let someone
on another network (incl. a restrictive university network) join, that server
needs a public `https://` URL. Two ways.

---

## A. Cloudflare Tunnel — server stays on your laptop (free, ~2 min)

Best for testing with a few people over a few days. No account beyond a free
Cloudflare login for the quick tunnel; works from behind any NAT/firewall
because the tunnel dials **out** from your machine over 443.

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

Then:

- **Clients** (anywhere): set the server URL to
  `https://<random-words>.trycloudflare.com` — register, log in. WebSockets
  upgrade to `wss://` automatically.
- **Dashboard**: `https://<random-words>.trycloudflare.com/?admin=<the token>`

Notes:

- `PQMSG_PUBLIC=1` is **required** for any internet-facing run. Behind a tunnel
  every request looks like `127.0.0.1`, so without it the admin dashboard would
  be open to the world. `PQMSG_PUBLIC=1` turns off that loopback bypass and
  forces the admin token.
- The quick-tunnel hostname changes every restart. For a stable name, create a
  **named tunnel** (needs a domain on Cloudflare, still free):
  `cloudflared tunnel login` → `cloudflared tunnel create pqmsg` →
  `cloudflared tunnel route dns pqmsg chat.example.com` →
  `cloudflared tunnel run --url http://localhost:8787 pqmsg`.
- Your laptop must stay awake and online. `server-data/` persists locally.

---

## B. Always-on cloud server (free tier: Oracle Always Free; or ~$5/mo VPS)

Best once other people actually depend on it. Target: ~100 concurrent users is a
single small instance — no load balancer, no Redis, no autoscaling.

1. Provision a small VM (Oracle Cloud "Always Free" ARM, or a $5 Hetzner/DO box).
   1 vCPU / 1 GB RAM / a few GB disk is plenty.
2. Install Node 18+ and [Caddy](https://caddyserver.com/docs/install).
3. Clone the repo, `npm ci`, then run the server on `127.0.0.1:8787`:
   ```bash
   PQMSG_PUBLIC=1 PQMSG_ADMIN_TOKEN=xxxxxxxx PQMSG_HOST=127.0.0.1 \
     node server/src/index.js
   ```
   (Put it under `systemd` or `pm2` so it restarts.)
4. `Caddyfile` — Caddy gets a Let's Encrypt cert and terminates HTTPS/WSS on 443:
   ```
   chat.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```
   `caddy run` (or `systemctl start caddy`). WebSockets pass through with no extra
   config.
5. Clients use `https://chat.example.com`. Dashboard:
   `https://chat.example.com/?admin=<token>`.

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
