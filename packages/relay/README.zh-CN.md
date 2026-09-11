# herdr-remote-relay

*[English](README.md) · [简体中文](README.zh-CN.md)*

[Herdr Remote](https://www.npmjs.com/package/herdr-remote) 的独立 Relay 服务端与 WebUI。

负责在浏览器与工作站主机连接器之间转发 WebSocket 连接。运行时仅依赖 `ws`，无需编译环境或 Herdr 二进制文件。

> **提示**：`herdr-remote` 默认在本地自动运行 relay。仅在需要部署独立中继服务器时安装本包。

## 安装

```bash
npm install -g herdr-remote-relay
herdr-remote-relay --public-url https://herdr.example.com --password <密码>
```

前置要求：Node.js 22+、TLS 反向代理（nginx、Caddy、Cloudflare Tunnel 等）。

## Docker 运行

```bash
docker run -d --name herdr-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v herdr-relay:/data \
  -e RELAY_BIND=0.0.0.0 \
  -e RELAY_PUBLIC_URL=https://herdr.example.com \
  -e RELAY_PASSWORD=你的密码 \
  -e RELAY_ADMIN_TOKEN=你的管理令牌 \
  -e RELAY_TRUST_PROXY=1 \
  -e RELAY_AUTH_STATE_FILE=/data/relay-auth.json \
  node:22-alpine npx -y herdr-remote-relay
```

## 配置参数

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--public-url` | `RELAY_PUBLIC_URL` | `http://127.0.0.1:8787` | 浏览器访问的公开地址 |
| `--password` | `RELAY_PASSWORD` | *(空)* | 工作站接入密码（留空为公用 Relay） |
| `--admin-token` | `RELAY_ADMIN_TOKEN` | *(空)* | `/admin` 管理后台操作员令牌 |
| `--bind` | `RELAY_BIND` | `127.0.0.1` | 监听地址 |
| `--port` | `RELAY_PORT` | `8787` | 监听端口 |
| `--trust-proxy` | `RELAY_TRUST_PROXY` | `0` | 信任 `X-Forwarded-For` 头（反代后设为 `1`） |
| `--state-file` | `RELAY_AUTH_STATE_FILE` | `~/.local/state/herdr-remote-relay/relay-auth.json` | 认证状态文件路径 |
| `--allowed-origins` | `RELAY_ALLOWED_ORIGINS` | *(同源)* | 允许的跨域源，逗号分隔 |
| `--max-clients` | `RELAY_MAX_CLIENTS_PER_HOST` | `16` | 每台工作站最大客户端连接数 |
| `--max-hosts` | `RELAY_MAX_HOSTS` | `1024` | relay 最大工作站数 |
| `--max-pending-handshakes` | `RELAY_MAX_PENDING_HANDSHAKES` | `1024` | 最大未认证 WebSocket 握手数 |
| `--max-buffered-bytes` | `RELAY_MAX_BUFFERED_BYTES_PER_CLIENT` | `4194304` | 单个慢浏览器最大待发送缓冲 |
| `--host-reconnect-grace-ms` | `RELAY_HOST_RECONNECT_GRACE_MS` | `30000` | 工作站断线恢复宽限时间 |
| `--config` | `HERDR_RELAY_CONFIG` | *(无)* | JSON 配置文件路径 |

反向代理必须转发 WebSocket `Upgrade` 头，并设置合理的空闲超时时间。relay 会关闭 WebSocket 压缩并启用 TCP NoDelay；没有浏览器连接时，工作站会停止业务 heartbeat，同时保留低频 transport keepalive（最小空闲 heartbeat 与 WebSocket ping/pong 探针）以防止反代断开空闲连接并维持 relay 存活。`deploy/` 目录下提供 nginx、systemd 与 Docker Compose 示例。

## 多工作站与隔离

同一个浏览器可以保存多个工作站配对，WebUI 左下角的实例切换器只显示本地已保存的实例，不会枚举 relay 上的其他工作站。`/api/status` 按设备令牌绑定的工作站隔离，只有 `RELAY_ADMIN_TOKEN` 才能查看 relay 全局状态；`/healthz` 不公开工作站和客户端数量。

## 工作站连接

在工作站的 `herdr-remote` TUI 中进入 **Relay** 页面：
- 访问方式选择 **自建 relay**
- Relay 地址填写 `wss://herdr.example.com`
- Relay 密码填写对应的 `RELAY_PASSWORD`

验证连接状态：
```bash
curl https://herdr.example.com/healthz
```

## 开源协议

MIT
