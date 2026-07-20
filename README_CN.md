# Veilink

[![CI](https://github.com/OVINC-CN/Veilink/actions/workflows/ci.yml/badge.svg)](https://github.com/OVINC-CN/Veilink/actions/workflows/ci.yml)

隐私优先、阅后即清的浏览器聊天工具。消息和文件采用端到端加密，应用服务器不接收聊天明文；系统不使用数据库，聊天室仅在至少一个已认证的浏览器 Tab 保持连接时存在。

[English](README.md)

> **安全状态：** 项目目前仍是早期实现。用于敏感场景前，请自行审查威胁模型与部署配置。

## 功能概览

- 通过邀请链接及单独分享的 6 位 PIN 加入聊天室。
- 浏览器本地使用链接密钥和 PIN 派生 E2EE 密钥；读取 URL Fragment 后立即从地址栏移除。
- 聊天数据通过 WebRTC DataChannel 传输，Fastify 只负责房间成员和 WebRTC 信令。
- 支持全房间统一的 P2P 直连与强制 TURN 中继。P2P 会向成员显示彼此公网 IP；TURN 模式隐藏成员间的 IP。
- 房间和信令状态仅保存在进程内存中。最后一人断开、到期、房主销毁或应用重启都会销毁聊天室。
- 支持受限富文本、本地生成的隐私链接卡片，以及受支持附件的内存预览。

## 架构

项目采用 pnpm workspace：React/Vite 浏览器客户端、Fastify 信令服务器以及共享协议包。生产容器从同一个 Origin 提供前端和 API。应用与 coturn 共享部署密钥，并为客户端签发短期 REST/HMAC TURN 凭据。

系统刻意不包含数据库、缓存服务、对象存储、文件上传接口、服务端聊天历史或可写数据卷。v1 只支持一个应用副本，禁止使用 `docker compose up --scale app=...` 扩容；多个副本无法共享房间状态。应用重启会使全部房间失效。

## 环境要求

- 本地构建：Node.js 22、pnpm 11
- 容器部署：Docker Engine、Docker Compose v2
- TURN 主机具备公网 IPv4，并开放 UDP/TCP 3478 及 UDP 49160–49200
- 公网聊天域名与有效 TLS 证书

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

构建后服务入口为 `apps/server/dist/index.js`。除 localhost 外必须使用 HTTPS，因为 WebRTC 和浏览器密码学 API 需要安全上下文。

## 容器部署

1. 复制并修改环境变量模板：

   ```bash
   cp .env.example .env
   openssl rand -hex 32
   ```

   将生成值写入 `TURN_REST_SECRET`。把 `APP_ORIGIN` 设置为浏览器实际访问的完整 HTTPS Origin，并替换所有示例 TURN 域名和 IP。`.env` 必须设置严格权限且不得提交到版本库。

2. 检查 Compose 固定子网是否与主机现有网络冲突。如需修改，必须同时调整 `VEILINK_SUBNET`、`VEILINK_GATEWAY` 以及受信代理地址。

3. 验证并启动：

   ```bash
   docker compose config --quiet
   docker compose build
   docker compose up -d
   ```

应用默认仅发布到 `127.0.0.1:3000`，必须放在外部 HTTPS 反向代理之后。coturn 对公网开放 UDP/TCP 3478 和配置的 UDP relay 端口段。Compose 不创建持久卷；两个容器均使用只读根文件系统，仅将不可避免的运行时文件写入小型 tmpfs。
Compose 还会禁用 Docker 容器日志驱动，避免 stdout/stderr 形成另一份持久连接日志；内存上限和“内存+交换区”上限设置为相同值，在容器运行时支持时阻止容器内存进入交换区，并禁用 Core Dump。

应用也可以直接终止 HTTPS。将 `TLS_CERT_FILE` 和 `TLS_KEY_FILE` 同时设置为应用容器内可读的 PEM 路径，只读挂载这两个文件，在目标网卡上发布应用端口，并把 `APP_ORIGIN` 设置为完全一致的 HTTPS Origin。两个变量都留空时，继续使用默认的外部反向代理方案。

Compose 会基于固定版本 `coturn/coturn:4.14.0-r0` 构建一层轻量镜像，复制上游二进制并去掉文件 Capability xattr，从而继续保留 `no-new-privileges` 和 `cap_drop: ALL`。否则 Linux 会以退出码 126 拒绝启动；该处理不会给运行时增加任何 Capability。
默认本地镜像标签为 `veilink:local` 和 `veilink-turn:local`；使用预构建镜像时，通过 `VEILINK_IMAGE` 和 `VEILINK_TURN_IMAGE` 指定不可变的 Registry 标签。

### 反向代理与可信 IP

反向代理必须支持 `/signal` 的 WebSocket Upgrade、保留原始 `Host`，并设置 `X-Forwarded-Proto: https`。只向用户公开 HTTPS。Nginx 最小配置示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

`TRUST_PROXY_CIDRS` 只能包含直接连接应用的代理节点。默认 Bridge 且代理位于 Docker 主机时，该节点为 `172.30.0.1/32`。禁止配置 `0.0.0.0/0`、宽泛私网段或无条件信任用户提交的转发头。如果代理也运行在容器中，应给它分配稳定地址并只信任该地址。

**必须关闭反向代理访问日志，或不可逆地匿名化源 IP 和 URL。** Veilink 无法控制上游基础设施的日志策略。生产环境不要开启 Fastify、coturn 或 Docker 连接日志。确需排障时，只能在有记录的短时间窗口临时开启，并在结束后安全删除生成的日志。

### TURN 网络

`TURN_EXTERNAL_IP` 是向浏览器公布的公网地址。入口脚本会自动将其与 coturn 容器私网地址配对；仅在自动检测错误时设置 `TURN_PRIVATE_IP`。防火墙及上游 NAT 必须转发 `.env` 中完全相同的 3478 TCP/UDP 和 UDP relay 端口段。

TCP 5349 的 TURN-over-TLS 为可选功能。它在 coturn 中终止，不能由普通 HTTP 反向代理代替。使用附带的 Overlay 只读挂载证书和私钥：

```bash
docker compose -f docker-compose.yml \
  -f docker-compose.turns.yml.example config --quiet
docker compose -f docker-compose.yml \
  -f docker-compose.turns.yml.example up -d
```

启用后还需在 `TURN_URLS` 中加入 `turns:turn.example.com:5349?transport=tcp`。证书和私钥是唯一可选的宿主机挂载，且只包含部署密钥，不包含用户数据。
私钥应通过宿主机所有权或 ACL 仅授权容器 UID 65534 读取，不要设置为全局可读。

## 主要配置

| 变量 | 用途 | 默认值/限制 |
| --- | --- | --- |
| `APP_ORIGIN` | 浏览器访问的完整公网 Origin | 必填 HTTPS URL |
| `VEILINK_IMAGE`、`VEILINK_TURN_IMAGE` | 应用和加固 coturn 镜像标签 | 默认本地构建标签 |
| `TLS_CERT_FILE`、`TLS_KEY_FILE` | 可选的应用原生 HTTPS PEM 路径 | 必须同时设置或同时留空 |
| `TRUST_PROXY_CIDRS` | 直接反向代理的 CIDR | 必填、必须精确 |
| `ROOM_TTL_SECONDS` | 内存聊天室存活时间 | `86400`，不可超过 |
| `STUN_URLS` | 浏览器使用的 STUN URL，逗号分隔 | 必填 |
| `TURN_URLS` | 浏览器使用的 TURN URL，逗号分隔 | 必填 |
| `TURN_REALM` | 应用和 coturn 共享的 Realm | `veilink` |
| `TURN_REST_SECRET` | 应用和 coturn 共享的 HMAC 密钥 | 必填，使用 32 个随机字节 |
| `TURN_CREDENTIAL_TTL_SECONDS` | 临时 TURN 凭据有效期（硬上限 600 秒） | `600` |
| `MAX_CONNECTIONS` | 全局 WebSocket 连接上限 | `2048` |
| `MAX_CONNECTIONS_PER_IP` | 单源 IP WebSocket 上限 | `64` |
| `MAX_ROOMS_PER_IP` | 单源 IP 创建的活动房间上限 | `32` |
| `ROOM_CREATE_ATTEMPTS_PER_MINUTE` | 单源 IP 每分钟建房尝试上限 | `20` |
| `TURN_EXTERNAL_IP` | TURN 公网 IPv4 | 必填 |
| `TURN_MIN_PORT`、`TURN_MAX_PORT` | 对外发布的 UDP relay 端口段 | `49160`–`49200` |

6 位房间 PIN 不是服务器环境密钥，也不能通过环境变量配置。它由每个房间随机生成，仅在浏览器中与链接 Fragment 混合派生密钥。

## 隐私边界

Veilink 不进行应用级持久化，但普通浏览器和操作系统无法绝对保证内存、Blob 实现、交换区、崩溃转储、历史同步、截图、扩展或下载文件从未写入存储介质。因此，“不留痕”是应用可控范围内的尽力保证，并非操作系统级承诺。

服务器宿主机同样存在这一边界：Compose 会在运行时支持时禁用容器交换区和 Core Dump，但休眠、虚拟机快照、宿主机崩溃采集和物理内存策略仍由部署方负责。

浏览器端只允许以下两类持久化例外：

1. 用户明确选择下载的文件。
2. localStorage 中的 `veilink.preferences.v1`：仅包含界面语言、主题、默认房间模式、文件大小限制、发送快捷键、时间显示、密度，以及可选的“记住昵称”开关和值。

此外，用户点击“复制”会主动把 PIN 或邀请链接交给系统剪贴板。剪贴板历史和云同步不受浏览器控制，可能在 Tab 关闭后继续保存；分享后应手动用无敏感内容覆盖剪贴板。

房间 ID、链接密钥、PIN、派生密钥、指纹、消息、链接、附件、成员地址和重连 Token 不得写入 localStorage、sessionStorage、IndexedDB、Cache API 或 Service Worker Cache。关闭或刷新 Tab 时会清空应用内存并撤销 Blob URL。

E2EE 可以阻止信令服务器和 TURN 服务器读取消息及文件内容，但不会向基础设施运营者隐藏连接元数据，也无法防御已失陷终端、恶意浏览器扩展或被替换的前端 JavaScript。从 P2P 切到 TURN 只能阻止后续 IP 暴露，无法收回其他成员已经看到的地址。

TURN REST 凭据和已建立的 allocation 无法按房间逐一即时吊销；默认凭据和 allocation 最长有效 10 分钟。房间销毁会立即删除应用内状态，但已有 TURN allocation 仍可能存活至 coturn 超时，且无法读取 E2EE 内容。

## 运维检查

- 应用始终保持单副本，并预期每次重启都会销毁活动房间。
- `TURN_REST_SECRET` 必须在应用和 coturn 中同步轮换；轮换会立即使现有 TURN 凭据失效。
- 严格限制 `.env` 和 TLS 私钥权限，CI 中不得打印其内容。
- 按隐私策略关闭或匿名化代理、负载均衡器、防火墙和 DNS 查询日志。
- 定期更新 Node.js、基础镜像、coturn 和依赖；执行 `pnpm audit --prod` 并重新构建镜像。
- Veilink 没有任何应用数据可备份或恢复。

## 许可证

[MIT](LICENSE)
