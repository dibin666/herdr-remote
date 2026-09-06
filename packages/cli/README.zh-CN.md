# herdr-remote

*[English](README.md) · [简体中文](README.zh-CN.md)*

[Herdr](https://herdr.dev) 工作区的 Web 终端客户端。支持移动端触控、低延迟 ANSI 传输与双语配置 TUI。

## 安装与运行

```bash
npm install -g herdr-remote
herdr-remote
```

直接运行 `herdr-remote` 即可启动向导并进入配置 TUI。

## 访问模式

- **仅本机** *(默认)*：仅本机浏览器可访问 (127.0.0.1)。
- **局域网 / Tailscale**：局域网或 Tailnet 内设备可访问 (0.0.0.0)。
- **官方 Relay**：使用官方公开 Relay (`wss://herdr-remote.564616.xyz`)。
- **自建 Relay**：连接独立部署的 [`herdr-remote-relay`](https://www.npmjs.com/package/herdr-remote-relay) 服务。

## 常用命令

```bash
herdr-remote start | stop | restart
herdr-remote status [--json]
herdr-remote pair [--json]
herdr-remote url
herdr-remote keepalive install | uninstall | restart | status
herdr-remote plugin link | unlink | status
herdr-remote --lang zh|en
```

## Herdr 插件

注册为 Herdr 插件：

```bash
herdr-remote plugin link
```

## 配置路径

- 配置文件：`~/.config/herdr-remote/config.json`
- 运行状态：`~/.local/state/herdr-remote/runtime.json` (权限 `0600`)

## 开源协议

MIT
