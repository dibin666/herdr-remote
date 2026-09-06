# 自建 relay 服务端

*[English](./self-hosted-relay.md)*

relay 用来从外网访问你的工作站。只有**自建 relay** 这种访问方式才需要它 ——
「仅本机」和「局域网 / Tailscale」由 `herdr-remote` 在本地起 relay，不用部署任何东西。

`herdr-remote-relay` 是独立的 npm 包，运行时依赖只有 `ws`，服务器不需要编译工具、
不需要装 Herdr、也不需要装插件。

如果只是让手机访问工作站，不需要自建 relay：在工作站的 `herdr-remote` 中选择
「局域网 / Tailscale」，本地 relay 会监听 `0.0.0.0`。TUI 里的「浏览器访问地址」
要填写实际的局域网或 Tailscale IP；`0.0.0.0` 只表示监听所有网卡，不能作为浏览器地址。

前置条件：Node.js 22+、一个域名、TLS（反向代理自己选，nginx、Caddy、Traefik、
Cloudflare Tunnel 都行）。

## Docker

预编译镜像发布在 GitHub Container Registry，支持 `linux/amd64` 和 `linux/arm64`：

```
ghcr.io/dibin666/herdr-remote-relay:latest
```

该包是私有的，先用带 `read:packages` 权限的 GitHub token 登录一次：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u dibin666 --password-stdin
```

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

`RELAY_BIND=0.0.0.0` 和 `RELAY_AUTH_STATE_FILE=/data/relay-auth.json` 已经是镜像
默认值，因此只需传上面这些配置。镜像以非 root 用户（uid 10001）运行，除 BusyBox
外不含包管理器和多余工具 —— 内容仅为 Alpine、Node 二进制、relay 源码和 `ws`。

生产部署建议固定版本号而不用 `latest`：

```bash
docker pull ghcr.io/dibin666/herdr-remote-relay:0.1.0
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

## 反向代理

不管用哪个代理，都要转发 WebSocket 升级请求，并且不要对空闲连接超时 —— 终端在
两次按键之间本来就是空闲的。包内 `deploy/` 里有 nginx 和 Cloudflare Tunnel 的
示例配置。

## 让工作站连过来

在工作站上运行 `herdr-remote`，打开 **Relay** 页面设置：

- **访问方式** → 自建 relay
- **Relay 地址** → `wss://herdr.example.com`
- **Relay 密码** → 与 `RELAY_PASSWORD` 相同（公用 relay 就留空）

按 `s` 保存，到**服务**页面重启，然后检查：

```bash
curl https://herdr.example.com/healthz    # hosts 应该是 1
```

在**配对设备**页面配对手机。

## 公用 relay

`RELAY_PASSWORD` 留空就是公用 relay：任何人都可以把工作站接进来。这样共享是安全的
—— 每台工作站只能通过它自己的主机令牌访问，而这个令牌在那台机器上生成，relay 从不
对外泄露。别人无法把设备配对到你的终端上。

公用 relay 泄露的是带宽，以及「你的工作站在线」这个事实。介意的话就设个密码。

## 说明

- 只有反向代理需要公网端口，relay 保持在回环地址上。
- relay 只保存令牌的 SHA-256 哈希，不保存令牌本身；终端内容永不落盘。
- 配对码 10 分钟过期，且只能用一次。
- 状态文件丢了只需重新配对设备，没有别的后果。

## 排查

| 现象 | 原因 |
|---|---|
| `hosts: 0` | 工作站没连上 —— 检查 `herdr-remote status` |
| `relay_password_required` | 两端密码不一致 |
| 页面能开但终端不出来 | 代理没转发 `Upgrade` 头 |
| 空闲 60 秒左右断开 | 代理读超时太短 |
