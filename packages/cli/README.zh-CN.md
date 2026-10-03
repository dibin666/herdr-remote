# herdr-remote

*[English](README.md) · [简体中文](README.zh-CN.md)*

[Herdr](https://herdr.dev) 工作区的 Web 终端客户端。支持移动端触控、低延迟 ANSI 传输与双语配置 TUI。

## 安装与运行

```bash
npm install -g https://github.com/dibin666/herdr-remote/releases/latest/download/herdr-remote.tgz
herdr-remote
```

直接运行 `herdr-remote` 即可启动向导并进入配置 TUI。
新版本先发布到 [GitHub Releases](https://github.com/dibin666/herdr-remote/releases)，npm 作为备用渠道（`npm install -g herdr-remote`）。`herdr-remote update` 从 GitHub 下载新版本并直接替换安装目录，不经过 npm；只有新版本改变了原生依赖 `node-pty`，或无法连接 GitHub 时才会用 npm。

已支持 Windows 10/11 原生运行（需 Node.js 22+），请在 PowerShell 中执行
`powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"` 安装 Herdr。
Herdr 的 Windows 插件功能仍处于 preview 阶段；首次以局域网模式启动时，请在 Windows
Defender 防火墙提示中允许 `node.exe` 通过专用网络通信。

## 访问模式

- **仅本机** *(默认)*：仅本机浏览器可访问 (127.0.0.1)。
- **局域网 / Tailscale**：局域网或 Tailnet 内设备可访问 (0.0.0.0)。
- **官方 Relay**：使用官方公开 Relay (`wss://herdr-remote.564616.xyz`)。
- **自建 Relay**：连接独立部署的 [`herdr-remote-relay`](../relay/README.zh-CN.md) 服务（容器镜像或 release 压缩包）。

## 常用命令

```bash
herdr-remote start | stop | restart
herdr-remote update [--json]  # 安装最新版本并重启服务
herdr-remote status [--json]
herdr-remote pair [--json]
herdr-remote url
herdr-remote admin-broker install | uninstall | restart | status # Windows
herdr-remote keepalive install | uninstall | restart | status
herdr-remote plugin link | unlink | status
herdr-remote --lang zh|en
```

在 Windows 上，可在 TUI 的「保活」页面注册以当前账户最高权限运行的计划任务并启动 broker。选择「设置管理员终端」，使用运行 Herdr Remote 的同一账户批准一次 Windows 提权提示；之后，WebUI 的“管理员”按钮会在 Herdr 中新建一个管理员 PowerShell 标签页，不再重复弹出 UAC。也可以使用 `admin-broker install` 和 `admin-broker uninstall` 命令管理任务，使用 `admin-broker status` 检查 broker。`herdr-remote update` 会让 broker 以新版本重启（有管理员终端开着时除外），之后也可以用 `admin-broker restart` 重启，无需提权。

## Herdr 插件

注册为 Herdr 插件：

```bash
herdr-remote plugin link
```

## 配置路径

- 配置文件：`~/.config/herdr-remote/config.json`
- Windows 配置文件：`%APPDATA%\herdr-remote\config.json`
- 运行状态：`~/.local/state/herdr-remote/runtime.json` (权限 `0600`)
- Windows 运行状态：`%LOCALAPPDATA%\herdr-remote\runtime.json`

## herdr 命令的查找方式

依次查找 `HERDR_BIN_PATH`、`PATH`，以及常见安装目录（`~/.local/bin`、`~/.cargo/bin`、
`~/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 等）。后台管理器不会继承 shell 环境，
因此 `herdr-remote keepalive install` 会把找到的可执行文件路径和当前 `PATH` 写入
systemd unit、launchd plist、Windows 登录任务（`windows-task`）或 Windows 服务（`windows-service`）。

Windows 上只查找 `herdr.exe`，还会搜索 `%LOCALAPPDATA%\Programs\Herdr\bin`、
`~\.cargo\bin` 和 `~\scoop\shims`。

`herdr-remote status --json` 会输出 `host.herdrCommand` 与 `host.herdrCommandFound`。
若显示未找到，请将 `HERDR_BIN_PATH` 设为完整路径后重新安装保活服务。

## 开源协议

MIT
