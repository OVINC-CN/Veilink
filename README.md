# Veilink

Veilink is an ephemeral, end-to-end encrypted browser chat. The redesigned
client uses a three-column Signal Glass interface and follows the operating
system's light or dark appearance by default.

[简体中文](README_CN.md)

## Security and transport model

- Messages and files travel only over peer-to-peer WebRTC DataChannels.
- STUN may be used for address discovery. STUN does not relay chat or file data.
- TURN URLs, relay ICE candidates, and SDP containing relay candidates are
  rejected on both the Go signalling server and the browser client.
- After a DataChannel opens, the browser checks the selected ICE candidate pair
  through WebRTC stats. Data is enabled only for `host`, `srflx`, or `prflx`
  pairs. If a direct path cannot be proven, the peer connection fails closed.
- The Go server carries room metadata, admission challenges, WebRTC signalling,
  and short-lived resume leases. It never receives plaintext messages or files.
- Message and file payloads remain end-to-end encrypted with keys derived in the
  browser from the invitation secret.

Pure P2P has an explicit availability trade-off: participants behind restrictive
or symmetric NATs may be unable to connect. Veilink does not fall back to a
relay. Direct P2P also exposes participant network addresses to one another and
to their network infrastructure.

## Refresh recovery

Refreshing an active room does not send `room.leave`. The browser stores a
tab-scoped encrypted checkpoint in `sessionStorage`; its AES-GCM key is kept in
the current history entry. The checkpoint contains the identity state, derived
room keys, rotating resume token, replay counters, and up to 100 text-only
messages. Critical counter updates are committed before a message is sent or
displayed. File payloads are not persisted.

The Go server keeps the member lease in Redis for `RECONNECT_GRACE_SECONDS` and
rotates the resume token after every successful restore. Explicit leave, room
destruction, expired or rejected recovery, and validation failures erase the
local checkpoint.

This mechanism survives an ordinary refresh in the same tab. It is not durable
history, does not survive every browser crash, and does not protect a compromised
page or malicious extension from secrets that are already accessible to that
page.

## Architecture

```text
Browser A  <-- encrypted WebRTC DataChannel, direct only -->  Browser B
    |                                                         |
    +------ WSS signalling and short-lived room state --------+
                              |
                       Go signalling server
                              |
                            Redis
```

- `apps/web`: React and Vite client
- `apps/server`: Go HTTP/WebSocket signalling service
- `packages/protocol`: browser-side schemas and cryptographic protocol helpers

The backend implementation and server process use Go and require no JavaScript
or Node.js runtime. Node.js is only a frontend build tool; Go serves the
resulting browser assets as static files.

## Local build

Requirements:

- Go 1.26.5 or newer (the server refuses known-vulnerable 1.26.0–1.26.4 runtimes)
- Node.js 22
- pnpm 11
- Redis 7.4 or newer

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
```

The resulting server binary is built from `apps/server/cmd/veilink`. The client
bundle is in `apps/web/dist`. Configure the variables below before starting the
binary; it serves the client and API from one origin.

## Configuration

Copy `.env.example` to a protected deployment environment and replace every
example secret or hostname.

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact browser origin; HTTPS is required outside loopback |
| `REDIS_URL` | Authenticated Redis URL; both `redis://` and `rediss://` are supported |
| `REDIS_KEY_PREFIX` | Namespace for short-lived room state |
| `STATE_HMAC_SECRET` | Independent secret used to pseudonymize abuse-control IP keys; at least 32 characters |
| `STUN_URLS` | Comma-separated `stun:` discovery endpoints; TURN is rejected |
| `TRUST_PROXY_CIDRS` | Explicit CIDRs for the direct reverse-proxy hop |
| `RECONNECT_GRACE_SECONDS` | Refresh/reconnect lease, default 30 seconds |
| `ROOM_TTL_SECONDS` | Room metadata lifetime, maximum 86,400 seconds |
| `MAX_CONNECTIONS` | Global Redis-backed connection cap |
| `MAX_CONNECTIONS_PER_IP` | Per-IP connection cap |
| `MAX_ROOMS_PER_IP` | Per-IP active room cap |
| `ROOM_CREATE_ATTEMPTS_PER_MINUTE` | Per-IP creation rate |

`APP_ORIGIN` must match the browser's `Origin` header exactly. Trust proxy
headers only from a controlled direct hop. Disable or irreversibly anonymize
reverse-proxy access logs because room URLs and source IPs are sensitive
metadata.

## Container deployment

```bash
docker compose --env-file .env.example config --quiet
docker compose --env-file .env up -d --build
```

The image uses a statically linked Go binary in a non-root distroless runtime.
Compose drops Linux capabilities, enables `no-new-privileges`, uses a read-only
root filesystem, publishes the app on loopback by default, and contains no TURN
service or relay port exposure.

Terminate TLS at a hardened reverse proxy or configure both `TLS_CERT_FILE` and
`TLS_KEY_FILE`. WebRTC and browser cryptography require a secure context outside
localhost.

## Operational notes

- Redis stores only transient room, membership, challenge, lease, and rate-limit
  metadata. Configure TTL monitoring; prefer `rediss://` on untrusted networks.
- Rotate `STATE_HMAC_SECRET` as a coordinated deployment; rotation resets IP
  pseudonyms used by abuse controls.
- Patch Go, Node build tooling, base images, and dependencies regularly.
- A compromised endpoint, frontend bundle, browser extension, or invitation
  secret defeats end-to-end confidentiality. Verify production asset integrity
  and protect the deployment pipeline.
