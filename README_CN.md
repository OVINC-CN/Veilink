# Veilink

Veilink 是一个临时、端到端加密的浏览器聊天工具。新版前端采用三栏
Signal Glass 界面，并默认跟随操作系统切换浅色和深色外观。

[English](README.md)

## 安全与传输模型

- 消息和文件通过强制使用 Cloudflare Realtime TURN 的 WebRTC DataChannel
  传输；客户端会拒绝直连和 STUN 发现的路径。
- Go 服务使用长期 Cloudflare TURN Key 换取浏览器短期凭证，长期 Key 永远
  不会下发给客户端。
- Go 信令服务和浏览器只接受 `relay` ICE candidate，以及不含 candidate
  或只含 relay candidate 的 SDP。
- Go 服务只处理房间元数据、准入挑战、WebRTC 信令和短期恢复租约，无法
  看到消息或文件明文。
- 消息和文件密钥由浏览器使用邀请链接中的秘密派生，内容保持端到端加密。

Cloudflare 会中继加密后的 WebRTC 数据包，并能观察网络和流量元数据；额外的
应用层端到端加密使其无法读取消息或文件内容。TURN 带宽用量会随成员数量增长。

## 刷新恢复

刷新活动房间时，客户端不会发送 `room.leave`。浏览器会把标签页级的加密
检查点保存到 `sessionStorage`，AES-GCM 密钥保存在当前 history entry 中。
检查点包含身份状态、房间派生密钥、轮换式恢复令牌、防重放计数器，以及最多
100 条纯文本消息。关键计数器会在消息发送或显示前完成写入；文件内容不会被
持久化。

Go 服务会在 `RECONNECT_GRACE_SECONDS` 内将成员租约保留在 Redis，并在每次
成功恢复后轮换恢复令牌。主动离开、销毁房间、恢复过期或被拒绝、数据校验
失败都会删除本地检查点。

该机制用于同一标签页中的普通刷新，不是持久聊天记录，也不保证跨所有浏览器
崩溃恢复。页面已被攻陷或恶意扩展能够访问页面时，无法靠本机制隐藏页面本来
就能读取的密钥。

## 架构

```text
浏览器 A  <-- 加密 WebRTC -->  Cloudflare TURN  <-- 加密 WebRTC -->  浏览器 B
    |                                                                    |
    +---------------- WSS 信令与短期房间状态 -----------------------------+
                                  |
                              Go 信令服务
                                  |
                                Redis
```

- `apps/web`：React 与 Vite 客户端
- `apps/server`：Go HTTP/WebSocket 信令服务
- `packages/protocol`：浏览器侧数据结构与加密协议工具

后端实现与服务端进程只使用 Go，不需要 JavaScript 或 Node.js 运行时；Node.js
只负责构建前端，产出的浏览器静态资源由 Go 提供。

## 本地构建

依赖：

- Go 1.26.5 或更高版本（服务端会拒绝存在已知漏洞的 1.26.0–1.26.4 运行时）
- Node.js 22
- pnpm 11
- Redis 7.4 或更高版本

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
```

服务端二进制入口为 `apps/server/cmd/veilink`，前端产物位于
`apps/web/dist`。启动二进制前先配置下列环境变量；生产服务从同一个 Origin
提供前端和 API。

## 配置

复制 `.env.example` 到受保护的部署环境，并替换所有示例密钥和域名。

| 变量 | 用途 |
| --- | --- |
| `APP_ORIGIN` | 浏览器实际 Origin；非回环地址必须使用 HTTPS |
| `REDIS_URL` | 带认证的 Redis 地址；支持 `redis://` 和 `rediss://` |
| `REDIS_KEY_PREFIX` | 短期房间状态命名空间 |
| `STATE_HMAC_SECRET` | 对滥用控制 IP 键进行假名化的独立密钥，至少 32 个字符 |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare Realtime TURN Key 标识符 |
| `CLOUDFLARE_TURN_API_TOKEN` | 仅服务端使用的短期 TURN 凭证签发 Token |
| `TURN_CREDENTIAL_TTL_SECONDS` | 短期凭证有效期，默认 90,000 秒 |
| `ROOM_CREATION_PASSWORD` | 可选的共享创建密码；留空时允许任何人创建 |
| `TRUST_PROXY_CIDRS` | 允许提供客户端 IP 的直接反向代理 CIDR |
| `RECONNECT_GRACE_SECONDS` | 刷新/重连租约，默认 30 秒 |
| `ROOM_TTL_SECONDS` | 房间元数据有效期，上限 86,400 秒 |
| `MAX_CONNECTIONS` | Redis 全局连接上限 |
| `MAX_CONNECTIONS_PER_IP` | 单 IP 连接上限 |
| `MAX_ROOMS_PER_IP` | 单 IP 活动房间上限 |
| `ROOM_CREATE_ATTEMPTS_PER_MINUTE` | 单 IP 每分钟创建次数 |

`APP_ORIGIN` 必须与浏览器 `Origin` 请求头完全一致。只信任受控的直接代理
节点。反向代理访问日志必须关闭或不可逆匿名化，因为房间 URL 和源 IP 都属于
敏感元数据。

可选的会话创建密码是部署级创建权限，不会写入 Redis。它与加入特定房间所需的
6 位邀请 PIN、以及用于派生端到端加密密钥的邀请密钥相互独立。修改创建密码
不会影响已有房间或加入已有邀请。启用后必须通过 HTTPS 提供应用，确保密码只经
WSS 发送。

## 容器部署

```bash
docker compose --env-file .env.example config --quiet
docker compose --env-file .env up -d --build
```

镜像使用静态链接的 Go 二进制和非 root distroless 运行时。Compose 会移除
Linux capabilities、启用 `no-new-privileges`、使用只读根文件系统，并默认只在
回环地址发布应用。TURN 由 Cloudflare Realtime 托管，因此部署无需开放本地
中继端口。

请在加固的反向代理终止 TLS，或同时配置 `TLS_CERT_FILE` 与
`TLS_KEY_FILE`。除 localhost 外，WebRTC 与浏览器密码学要求安全上下文。

## 运维说明

- Redis 只保存临时房间、成员、挑战、租约和限流元数据；应监控 TTL，并在
  不可信网络中优先使用 `rediss://`。
- `STATE_HMAC_SECRET` 应协调轮换；轮换后滥用控制中的 IP 假名会重置。
- 监控 Cloudflare TURN 的可用性、凭证签发和中继带宽费用。Cloudflare
  Realtime TURN 不部署在其中国网络内。
- 定期更新 Go、Node 构建工具、基础镜像和依赖。
- 终端、前端产物、浏览器扩展或邀请秘密一旦失陷，端到端机密性也会失效。
  生产环境应验证静态资源完整性并保护发布流水线。
