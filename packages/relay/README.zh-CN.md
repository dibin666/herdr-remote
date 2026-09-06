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
| `--config` | `HERDR_RELAY_CONFIG` | *(无)* | JSON 配置文件路径 |

反向代理必须转发 WebSocket `Upgrade` 头，并设置较长空闲超时时间。`deploy/` 目录下提供 nginx、systemd 与 Docker Compose 示例。

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
