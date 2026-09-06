# 自建 relay 服务端

*[English](./self-hosted-relay.md)*

relay 用于从外网访问工作站。仅在「自建 relay」模式下需要单独部署；「仅本机」与「局域网 / Tailscale」模式均由 `herdr-remote` 在本地运行 relay，无需额外服务器。

前置条件：Node.js 22+、域名、TLS 反向代理（nginx、Caddy、Traefik、Cloudflare Tunnel 等）。

## Docker

```bash
docker run -d --name herdr-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v herdr-relay:/data \
  -e RELAY_PUBLIC_URL=https://herdr.example.com \
  -e RELAY_PASSWORD=你的密码 \
  -e RELAY_ADMIN_TOKEN=你的长随机管理令牌 \
  -e RELAY_TRUST_PROXY=1 \
  ghcr.io/dibin666/herdr-remote-relay:latest
```

```bash
docker pull ghcr.io/dibin666/herdr-remote-relay:latest
```

## Docker Compose

```yaml
services:
  relay:
    image: ghcr.io/dibin666/herdr-remote-relay:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      RELAY_PUBLIC_URL: https://herdr.example.com
      RELAY_PASSWORD: 你的密码
      RELAY_ADMIN_TOKEN: 你的长随机管理令牌
      RELAY_TRUST_PROXY: "1"
    volumes:
      - relay-state:/data

volumes:
  relay-state:
```

```bash
docker compose up -d
```

### 自行构建镜像

构建上下文是仓库根目录，因为浏览器端资源来自 `packages/relay/web` workspace：

```bash
docker build -f packages/relay/Dockerfile -t herdr-remote-relay .
```

## npm

```bash
npm install -g herdr-remote-relay
herdr-remote-relay --public-url https://herdr.example.com --password 你的密码 \
  --admin-token 你的长随机管理令牌 --trust-proxy
```

包内 `deploy/systemd/` 有现成的 systemd 单元文件。

## 配置项

| 变量 | 默认值 | |
|---|---|---|
| `RELAY_PUBLIC_URL` | `http://127.0.0.1:8787` | 浏览器访问的地址 |
| `RELAY_DEPLOYMENT_MODE` | `remote` | 标记为 relay 操作员后台（`local` 仅由工作站管理的 relay 使用） |
| `RELAY_PASSWORD` | *（无）* | 工作站接入密码。**留空 = 公用 relay** |
| `RELAY_ADMIN_TOKEN` | *（无）* | `/admin` relay 管理面板使用的操作员令牌 |
| `RELAY_BIND` | `127.0.0.1` | 监听地址（Docker 里用 `0.0.0.0`） |
| `RELAY_PORT` | `8787` | 监听端口 |
| `RELAY_TRUST_PROXY` | `0` | 有反向代理时设为 `1` |
| `RELAY_AUTH_STATE_FILE` | `~/.local/state/herdr-remote-relay/relay-auth.json` | 设备记录 |
| `RELAY_ALLOWED_ORIGINS` | *（仅同源）* | 额外允许的浏览器来源，逗号分隔 |
| `RELAY_MAX_CLIENTS_PER_HOST` | `16` | 每台工作站允许的浏览器数 |
| `RELAY_MAX_HOSTS` | `1024` | relay 允许登记的工作站数 |
| `RELAY_MAX_PENDING_HANDSHAKES` | `1024` | 最大未认证 WebSocket 握手数 |
| `RELAY_MAX_BUFFERED_BYTES_PER_CLIENT` | `4194304` | 单个浏览器最大待发送缓冲，超出仅断开该慢客户端 |
| `RELAY_HOST_RECONNECT_GRACE_MS` | `30000` | 工作站短暂断线时保留已授权浏览器的宽限时间 |

## 反向代理

不管用哪个代理，都要转发 WebSocket 升级请求，并且不要对空闲连接超时 —— 终端在
两次按键之间本来就是空闲的。包内 `deploy/` 里有 nginx 和 Cloudflare Tunnel 的
示例配置。relay 会关闭 WebSocket 压缩并启用 TCP NoDelay；浏览器无人连接时，工作站
会停止业务 heartbeat，只保留 WebSocket 存活探测以节省流量。

## 让工作站连过来

在工作站上运行 `herdr-remote`，打开 **Relay** 页面设置：

- **访问方式** → 自建 relay
- **Relay 地址** → `wss://herdr.example.com`
- **Relay 密码** → 与 `RELAY_PASSWORD` 相同（公用 relay 就留空）

按 `s` 保存，到**服务**页面重启，然后检查：

```bash
curl https://herdr.example.com/healthz    # 仅返回存活信息
curl -H "X-Herdr-Host-Id: <host-id>" -H "X-Herdr-Host-Token: <host-token>" \
  https://herdr.example.com/api/status    # 查看当前主机的隔离状态
```

在**配对设备**页面配对手机。

## 公用 relay

`RELAY_PASSWORD` 留空就是公用 relay：任何人都可以把工作站接进来。这样共享是安全的
—— 每台工作站只能通过它自己的主机令牌访问，而这个令牌在那台机器上生成，relay 从不
对外泄露。别人无法把设备配对到你的终端上。

公用 relay 泄露的是带宽，以及「你的工作站在线」这个事实。介意的话就设个密码。

## 说明

- 浏览器可以保存多个工作站连接，底部实例切换器只显示本地已配对的实例，不会枚举 relay 上的其他工作站。
- `/api/status` 按设备令牌绑定的工作站隔离；只有设置 `RELAY_ADMIN_TOKEN` 的操作员后台能查看 relay 全部工作站。
- 如果 WebUI 与 relay 不同源，必须将精确来源加入 `RELAY_ALLOWED_ORIGINS`；relay 不会反射任意来源。
- `/healthz` 只返回存活信息，不公开工作站或客户端数量。
- 只有反向代理需要公网端口，relay 保持在回环地址上。
- relay 只保存令牌的 SHA-256 哈希，不保存令牌本身；终端内容永不落盘。
- 配对码 10 分钟过期，且只能用一次。
- 状态文件丢了只需重新配对设备，没有别的后果。

## 排查

| 现象 | 原因 |
|---|---|
| `/api/status` 中没有主机 | 工作站没连上 —— 检查 `herdr-remote status` |
| `relay_password_required` | 两端密码不一致 |
| 页面能开但终端不出来 | 代理没转发 `Upgrade` 头 |
| 空闲 60 秒左右断开 | 代理读超时太短 |
