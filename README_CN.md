<p align="center">
  <img src="apps/web/src/assets/brand/veilink-logo.png" alt="Veilink" width="256" />
</p>

<p align="center">
  <strong>房间消失，私密对话也随之消失。</strong>
</p>

<p align="center">
  一个用于消息与文件传输的临时、端到端加密浏览器聊天工具。<br />
  无需账号、无 Cookie、无服务端消息历史。
</p>

<p align="center">
  <a href="https://github.com/OVINC-CN/Veilink/actions/workflows/ci.yml"><img src="https://github.com/OVINC-CN/Veilink/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/OVINC-CN/Veilink/actions/workflows/images.yml"><img src="https://github.com/OVINC-CN/Veilink/actions/workflows/images.yml/badge.svg" alt="Container image" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/OVINC-CN/Veilink?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#核心特性">核心特性</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#安全模型">安全模型</a> ·
  <a href="#配置">配置</a> ·
  <a href="README.md">English</a>
</p>

---

## 为什么选择 Veilink？

多数聊天服务会在中心服务器上保留账号、消息历史或内容。Veilink 专为短期会话
设计：创建房间，通过不同渠道分别分享邀请链接和 6 位 PIN，即可直接在浏览器中
交流。房间会自动过期，Go 服务仅负责准入、信令和临时成员状态。

## 核心特性

- **端到端加密**：消息和文件在浏览器中完成加密，信令服务与 TURN 中继都不会
  收到内容明文。
- **仅中继 WebRTC**：DataChannel 强制通过 Cloudflare Realtime TURN；客户端会
  拒绝直连和 STUN 发现的路径，避免向其他成员暴露对端 IP。
- **更安全的邀请方式**：邀请密钥与 6 位 PIN 可通过两个不同渠道分别发送。
- **临时房间**：最多 8 位成员，24 小时内自动过期；房主可以续期或立即销毁房间。
- **完整聊天体验**：支持富文本、链接、引用回复、`@提及`、私密提及通知、表情、
  文件传输，以及图片、音频、视频和 PDF 预览。
- **刷新恢复**：使用标签页级加密检查点恢复普通刷新前的活动会话，不生成持久
  聊天记录。
- **为自托管而生**：单个 Go 服务同时提供 API 和编译后的 React 客户端，Redis
  保存短期状态，并提供 `linux/amd64` 与 `linux/arm64` 容器镜像。
- **响应式双语界面**：适配桌面和移动端，支持跟随系统/浅色/深色主题、紧凑模式、
  简体中文和英文。

## 工作原理

1. 房主创建房间，获得邀请链接和 6 位 PIN。
2. 访客打开链接，并证明自己持有由 PIN 派生的准入密钥。
3. Go 服务协调房间状态和 WebRTC 信令；加密的聊天与文件内容通过仅中继的
   DataChannel 在浏览器之间传输。
4. 房间到期后自动消失，房主也可以立即将其销毁。

```text
浏览器 A  <== 加密 WebRTC ==>  Cloudflare TURN  <== 加密 WebRTC ==>  浏览器 B
    |                                                                       |
    +---------------- WSS 信令与短期房间状态 -------------------------------+
                                     |
                                Go 信令服务
                                     |
                                   Redis
```

Veilink 使用对等网状连接，因此 TURN 带宽会随房间成员数量增长。Cloudflare 能够
观察网络与流量元数据，但应用层端到端加密使其无法读取消息或文件内容。

## 快速开始

> [!IMPORTANT]
> 部署 Veilink 需要外部 Redis 实例和 Cloudflare Realtime TURN Key。公开部署
> 必须使用 HTTPS。

```bash
git clone https://github.com/OVINC-CN/Veilink.git
cd Veilink
cp .env.example .env
```

编辑 `.env`，替换所有示例域名、凭证与密钥。至少需要配置 `APP_ORIGIN`、
`REDIS_URL`、`STATE_HMAC_SECRET`、`CLOUDFLARE_TURN_KEY_ID`、
`CLOUDFLARE_TURN_API_TOKEN` 和 `TRUST_PROXY_CIDRS`。

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
```

Compose 默认将 Veilink 发布到 `127.0.0.1:3000`。请在前方配置经过加固的 HTTPS
反向代理，或配置原生 TLS。TURN 由 Cloudflare 托管，无需开放本地中继端口。

### 从源码构建

环境要求：

- Go 1.26.5 或更高版本
- Node.js 22
- pnpm 11
- Redis 7.4 或更高版本（运行部署时需要）

```bash
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web lint
pnpm --dir apps/web typecheck
pnpm --dir apps/web test
pnpm --dir apps/web build

GOTOOLCHAIN=local go -C apps/server vet ./...
GOTOOLCHAIN=local go -C apps/server build ./...
```

前端产物位于 `apps/web/dist`。服务端入口为 `apps/server/cmd/veilink`；生产环境中，
它会从同一个 Origin 提供编译后的浏览器资源和 API。Node.js 只用于构建前端，
服务端运行时不需要 Node.js。

## 配置

请从 [`.env.example`](.env.example) 开始配置。完成后的文件应保留在版本控制之外，
并为每个部署生成相互独立的密钥。

| 变量 | 必需 | 说明 |
| --- | :---: | --- |
| `APP_ORIGIN` | 是 | 浏览器实际公开 Origin；非回环地址必须使用 HTTPS |
| `REDIS_URL` | 是 | 带认证的 `redis://` 或 `rediss://` 地址 |
| `STATE_HMAC_SECRET` | 是 | 对滥用控制 IP 键进行假名化的独立密钥；至少 32 个字符 |
| `CLOUDFLARE_TURN_KEY_ID` | 是 | Cloudflare Realtime TURN Key 标识符 |
| `CLOUDFLARE_TURN_API_TOKEN` | 是 | 仅服务端使用的短期 TURN 凭证签发 Token |
| `TRUST_PROXY_CIDRS` | 使用代理时 | 受控的直接反向代理节点 CIDR |
| `ROOM_CREATION_PASSWORD` | 否 | 创建房间所需的共享部署密码；留空时允许公开创建 |
| `REDIS_KEY_PREFIX` | 否 | 短期状态命名空间；默认 `veilink` |
| `TURN_CREDENTIAL_TTL_SECONDS` | 否 | TURN 凭证有效期；默认 `90000` |
| `RECONNECT_GRACE_SECONDS` | 否 | 刷新/重连租约；默认 `30` |
| `ROOM_TTL_SECONDS` | 否 | 房间初始有效期及房主每次续期后恢复的完整有效期；默认值及上限均为 `86400` |
| `MAX_CONNECTIONS` | 否 | Redis 全局连接上限；默认 `2048` |
| `MAX_CONNECTIONS_PER_IP` | 否 | 单 IP 连接上限；默认 `64` |
| `MAX_ROOMS_PER_IP` | 否 | 单 IP 活动房间上限；默认 `32` |
| `ROOM_CREATE_ATTEMPTS_PER_MINUTE` | 否 | 单 IP 每分钟创建次数；默认 `20` |

`APP_ORIGIN` 必须与浏览器的 `Origin` 请求头完全一致。只应信任受控的直接代理
节点。房间 URL 和源 IP 都属于敏感元数据，因此反向代理访问日志必须关闭或进行
不可逆匿名化。

可选的房间创建密码用于控制谁能在当前部署创建房间。它与每个房间的邀请 PIN
及加密密钥相互独立，不会存入 Redis，也不会影响已有房间。

## 安全模型

| 层级 | 设计 |
| --- | --- |
| 聊天内容 | 浏览器端 XChaCha20-Poly1305 认证加密 |
| 文件传输 | 分块 XChaCha20-Poly1305 secret stream，并进行摘要校验 |
| 消息身份 | 每个会话使用 Ed25519 签名和防重放计数器 |
| 密钥材料 | 在浏览器中由邀请秘密派生；长期 TURN 凭证仅保留在服务端 |
| 对等传输 | WebRTC DataChannel 仅允许 Cloudflare TURN relay candidate |
| 服务端状态 | 仅包含房间元数据、准入挑战、信令、租约和限流数据 |

Go 服务使用长期 Cloudflare TURN Key 换取浏览器短期凭证。浏览器和信令服务都会
拒绝非 relay ICE candidate，以及包含直连 candidate 的 SDP。

### 刷新恢复

在同一标签页普通刷新时，Veilink 会把加密检查点写入 `sessionStorage`，其
AES-GCM 密钥保留在当前 history entry 中。检查点包含身份与房间密钥状态、轮换式
恢复令牌、防重放计数器，以及最多 100 条纯文本消息；文件内容永远不会被持久化。

Redis 会在 `RECONNECT_GRACE_SECONDS` 内保留成员租约，并在每次成功恢复后轮换
恢复令牌。主动离开、销毁房间、恢复过期或被拒绝、数据校验失败都会删除检查点。

这只是刷新恢复机制，不是持久聊天记录。终端、前端产物、浏览器扩展或邀请秘密
一旦失陷，本机制无法继续保障机密性。将 Veilink 用于高风险会话前，请先评估其
威胁模型是否满足需求。

## 项目结构

```text
Veilink/
├── apps/
│   ├── web/       # React、TypeScript、Vite、浏览器密码学和 WebRTC
│   └── server/    # Go HTTP/WebSocket 信令服务
├── Dockerfile     # 多阶段、多架构生产镜像
└── docker-compose.yml
```

运行时镜像在非 root distroless 容器中使用静态链接的 Go 二进制。Compose 会移除
Linux capabilities、启用 `no-new-privileges`、使用只读根文件系统，并默认关闭
应用容器日志。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行[从源码构建](#从源码构建)中的现有
前端检查与 Go 构建命令。涉及安全边界的改动应保持小而清晰，并说明对威胁模型的
影响；请勿提交部署凭证或邀请信息。

## 开源许可

Veilink 基于 [MIT License](LICENSE) 发布。
