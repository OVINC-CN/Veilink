<p align="center">
  <img src="apps/web/src/assets/brand/veilink-logo.png" alt="Veilink" width="256" />
</p>

<p align="center">
  <strong>Private conversations that disappear when the room does.</strong>
</p>

<p align="center">
  An ephemeral, end-to-end encrypted browser chat for messages and files.<br />
  No account, no cookies, and no server-side message history.
</p>

<p align="center">
  <a href="https://github.com/OVINC-CN/Veilink/actions/workflows/ci.yml"><img src="https://github.com/OVINC-CN/Veilink/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/OVINC-CN/Veilink/actions/workflows/images.yml"><img src="https://github.com/OVINC-CN/Veilink/actions/workflows/images.yml/badge.svg" alt="Container image" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/OVINC-CN/Veilink?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#security-model">Security</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="README_CN.md">简体中文</a>
</p>

---

## Why Veilink?

Most chat services keep accounts, message history, or content on a central
server. Veilink is designed for short-lived conversations instead: create a
room, share the invitation link and six-digit PIN through separate channels,
and talk directly from the browser. Rooms expire automatically, while the Go
service only coordinates admission, signalling, and temporary membership.

## Features

- **End-to-end encrypted** — messages and files are encrypted in the browser;
  the signalling server and TURN relay never receive plaintext content.
- **Relay-only WebRTC** — DataChannels are forced through Cloudflare Realtime
  TURN. Direct and STUN-discovered paths are rejected to avoid exposing peer IPs.
- **Safer invitations** — the invitation secret and six-digit PIN can be shared
  through different channels.
- **Ephemeral rooms** — up to 8 members, automatic expiry within 24 hours, owner
  renewal and explicit room destruction.
- **A complete chat experience** — rich text, links, quoted replies, `@mentions`,
  private mention notifications, emoji, file transfer, and image/audio/video/PDF
  previews.
- **Refresh recovery** — encrypted tab-scoped checkpoints restore an active room
  after an ordinary refresh without creating durable chat history.
- **Built for self-hosting** — a single Go service serves both the API and the
  compiled React client, with Redis for short-lived state and multi-architecture
  container images for `linux/amd64` and `linux/arm64`.
- **Responsive and bilingual** — desktop and mobile layouts, system/light/dark
  themes, compact mode, English, and Simplified Chinese.

## How it works

1. A host creates a room and receives an invitation link plus a six-digit PIN.
2. Guests open the link and prove possession of the PIN-derived admission key.
3. The Go service coordinates room state and WebRTC signalling; encrypted chat
   and file payloads travel between browsers over relay-only DataChannels.
4. The room expires automatically, or its owner destroys it immediately.

```text
Browser A  <== encrypted WebRTC ==>  Cloudflare TURN  <== encrypted WebRTC ==>  Browser B
    |                                                                               |
    +------------------- WSS signalling and short-lived room state -----------------+
                                            |
                                   Go signalling server
                                            |
                                          Redis
```

Veilink uses a peer mesh, so TURN bandwidth grows with the number of room
members. Cloudflare can observe network and traffic metadata, but the additional
application encryption prevents it from reading message or file contents.

## Quick start

> [!IMPORTANT]
> A deployment needs an external Redis instance and a Cloudflare Realtime TURN
> key. Public deployments must use HTTPS.

```bash
git clone https://github.com/OVINC-CN/Veilink.git
cd Veilink
cp .env.example .env
```

Edit `.env` and replace every example hostname, credential, and secret. At a
minimum, configure `APP_ORIGIN`, `REDIS_URL`, `STATE_HMAC_SECRET`,
`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, and
`TRUST_PROXY_CIDRS`.

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
```

Compose publishes Veilink to `127.0.0.1:3000` by default. Put a hardened HTTPS
reverse proxy in front of it, or configure native TLS. TURN is hosted by
Cloudflare, so no local relay ports are required.

### Build from source

Requirements:

- Go 1.26.5 or newer
- Node.js 22
- pnpm 11
- Redis 7.4 or newer for a running deployment

```bash
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web lint
pnpm --dir apps/web typecheck
pnpm --dir apps/web test
pnpm --dir apps/web build

GOTOOLCHAIN=local go -C apps/server vet ./...
GOTOOLCHAIN=local go -C apps/server build ./...
```

The frontend bundle is written to `apps/web/dist`. The server entry point is
`apps/server/cmd/veilink`; in production it serves the compiled browser assets
and API from the same origin. Node.js is only required to build the frontend,
not to run the server.

## Configuration

Start with [`.env.example`](.env.example). Keep the finished file outside source
control and generate independent secrets for each deployment.

| Variable | Required | Description |
| --- | :---: | --- |
| `APP_ORIGIN` | Yes | Exact public browser origin; HTTPS is required outside loopback |
| `REDIS_URL` | Yes | Authenticated `redis://` or `rediss://` URL |
| `STATE_HMAC_SECRET` | Yes | Independent secret for pseudonymizing abuse-control IP keys; at least 32 characters |
| `CLOUDFLARE_TURN_KEY_ID` | Yes | Cloudflare Realtime TURN key identifier |
| `CLOUDFLARE_TURN_API_TOKEN` | Yes | Server-only token used to issue short-lived TURN credentials |
| `TRUST_PROXY_CIDRS` | Proxy | CIDRs of the controlled direct reverse-proxy hop |
| `ROOM_CREATION_PASSWORD` | No | Shared deployment password for creating rooms; empty allows public creation |
| `REDIS_KEY_PREFIX` | No | Namespace for short-lived state; default `veilink` |
| `TURN_CREDENTIAL_TTL_SECONDS` | No | TURN credential lifetime; default `90000`, range `300`–`172800` |
| `RECONNECT_GRACE_SECONDS` | No | Refresh/reconnect lease; default `30`, range `5`–`900` |
| `PEER_CONNECTION_TIMEOUT_SECONDS` | No | Hard timeout for initial TURN peer connections; default `90`, range `30`–`300`; a retry starts after `30` seconds |
| `ROOM_TTL_SECONDS` | No | Initial room lifetime and full lifetime restored by each host renewal; default `86400`, range `60`–`86400` |
| `MAX_ROOMS` | No | Global active room cap; default `1000`, range `1`–`100000` |
| `MAX_CONNECTIONS` | No | Global Redis-backed connection cap; default `2048`, range `1`–`100000` |
| `MAX_CONNECTIONS_PER_IP` | No | Per-IP connection cap; default `64`, range `1`–`10000` |
| `MAX_ROOMS_PER_IP` | No | Per-IP active room cap; default `32`, range `1`–`10000` |
| `ROOM_CREATE_ATTEMPTS_PER_MINUTE` | No | Per-IP room creation rate; default `20`, range `1`–`10000` |

`APP_ORIGIN` must exactly match the browser's `Origin` header. Only trust proxy
headers from a controlled direct hop. Disable or irreversibly anonymize reverse
proxy access logs because room URLs and source IPs are sensitive metadata.

Native TLS requires both `TLS_CERT_FILE` and `TLS_KEY_FILE`. When using Compose,
mount the certificate and key read-only through an override and set these values
to their paths inside the container.

The optional room creation password controls who may create rooms on a
deployment. It is separate from each room's invitation PIN and encryption
secret, is never stored in Redis, and does not affect existing rooms.

## Security model

| Layer | Design |
| --- | --- |
| Chat content | XChaCha20-Poly1305 authenticated encryption in the browser |
| File transfer | Chunked XChaCha20-Poly1305 secret streams with digest verification |
| Message identity | Per-session Ed25519 signatures and replay counters |
| Key material | Derived in the browser from the invitation secret; long-lived TURN credentials stay server-side |
| Peer transport | WebRTC DataChannels restricted to Cloudflare TURN relay candidates |
| Server state | Room metadata, admission challenges, signalling, leases, and rate limits only |

The Go service exchanges its long-lived Cloudflare TURN key for short-lived
browser credentials. Both the browser and signalling service reject non-relay
ICE candidates and SDP that contains direct candidates.

### Refresh recovery

During an ordinary same-tab refresh, Veilink stores an encrypted checkpoint in
`sessionStorage`; its AES-GCM key remains in the current history entry. The
checkpoint contains identity and room key state, a rotating resume token, replay
counters, and up to 100 text-only messages. File payloads are never persisted.

Redis retains the member lease for `RECONNECT_GRACE_SECONDS`, and the resume
token rotates after every successful restore. Explicit leave, room destruction,
expired or rejected recovery, and validation failures erase the checkpoint.

This is refresh recovery, not durable history. It does not protect against a
compromised endpoint, frontend bundle, browser extension, or leaked invitation
secret. Review the threat model before using Veilink for high-risk conversations.

## Project structure

```text
Veilink/
├── apps/
│   ├── web/       # React, TypeScript, Vite, browser crypto and WebRTC
│   └── server/    # Go HTTP/WebSocket signalling service
├── Dockerfile     # Multi-stage, multi-architecture production image
└── docker-compose.yml
```

The runtime image contains a statically linked Go binary in a non-root
distroless container. Compose drops Linux capabilities, enables
`no-new-privileges`, uses a read-only root filesystem, and disables application
container logs by default.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run the
existing frontend checks and Go build commands from [Build from source](#build-from-source).
Keep security-sensitive changes small, explain their threat-model impact, and
never commit deployment credentials or invitation material.

## License

Veilink is released under the [MIT License](LICENSE).
