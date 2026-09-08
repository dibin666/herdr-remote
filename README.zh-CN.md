# Herdr Remote

*[English](README.md) · [简体中文](README.zh-CN.md)*

[![herdr-remote on npm](https://img.shields.io/npm/v/herdr-remote?label=herdr-remote&color=0b7285)](https://www.npmjs.com/package/herdr-remote)
[![herdr-remote-relay on npm](https://img.shields.io/npm/v/herdr-remote-relay?label=herdr-remote-relay&color=0b7285)](https://www.npmjs.com/package/herdr-remote-relay)
[![node](https://img.shields.io/node/v/herdr-remote)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/herdr-remote)](./LICENSE)

[Herdr](https://herdr.dev) 工作区的 Web 终端客户端。支持移动端触控、低延迟 ANSI 流式传输与一次性配对。

```bash
npm install -g herdr-remote
herdr-remote
```

运行 `herdr-remote` 启动配置向导并运行后台服务。

需要 Herdr 0.9.0 或更高版本：每个浏览器窗口驱动各自的 Herdr 客户端，而客户端视图从 0.9.0 起才与工作站本机终端相互独立。

<img width="1237" height="665" alt="image" src="https://github.com/user-attachments/assets/cb57f108-d313-44b5-ac64-91a7ac95290a" />

## 包含的包

| 包名 | 运行位置 | 说明 |
|---|---|---|
| **`herdr-remote`** | 工作站 | Herdr 插件、主机连接器、配置 TUI |
| **`herdr-remote-relay`** | 任意机器 | 独立 WebSocket relay 服务及 WebUI 静态资源 |

`herdr-remote` 默认在本地启动 relay，也可连接外部独立部署的 relay。

## 访问模式

| 模式 | 可访问范围 | 需要独立服务器 |
|---|---|---|
| **仅本机** *(默认)* | 本机浏览器 | 否 |
| **局域网 / Tailscale** | 局域网或 Tailnet 内设备 | 否 |
| **官方 Relay** | 互联网任意网络 | 否（使用 `wss://herdr-remote.564616.xyz`） |
| **自建 Relay** | 互联网任意网络 | 是（[自建指南](docs/self-hosted-relay.zh-CN.md) · [English](docs/self-hosted-relay.md)） |

## 终端界面 (TUI)

直接执行 `herdr-remote` 打开配置界面（支持中英双语，默认跟随 `$LANG`）。

```
 Herdr Remote  在浏览器中使用 Herdr 工作区

 1 概览  2 配对设备  3 服务  4 Relay  5 保活  6 Herdr  7 语言与关于
 ╭──────────────────────────────────────────────────────────────────────╮
 │ 状态                                                                 │
 │                                                                      │
 │ 访问方式            仅本机                                           │
 │ Relay               ● 本地，127.0.0.1:8787  PID 1239815              │
 │ 主机连接器          ● 运行中  PID 1239816                            │
 │ Herdr 套接字        ● /home/you/.config/herdr/herdr.sock             │
 │ Web 界面            http://127.0.0.1:8787                            │
 │ 保活服务            ● systemd — 运行中                               │
 ╰──────────────────────────────────────────────────────────────────────╯
  ↑↓ 移动  ·  ↵ 选择  ·  ← → 切换页面  ·  m 开关鼠标  ·  q 退出
```

### 快捷键

- `↑↓`：移动光标
- `↵`：选择或编辑
- `←→` 或 `1`–`7`：切换页面
- `s`：保存配置
- `r`：刷新状态
- `m`：开关鼠标支持
- `q`：退出

## 多个 Herdr 实例

同一个浏览器可以多次配对不同的 Herdr 工作站。每次在左下角实例切换器选择“添加 Herdr 实例”，输入新配对码后即可保存；实例名称可在切换器中自定义，名称和凭据仅保存在当前浏览器。切换时只保持当前实例连接，以减少 relay 流量。

## 设备配对

1. 在 TUI 中打开**配对设备**页面（或运行 `herdr-remote pair`）。
2. 手机扫描二维码或在浏览器中输入 6 位配对码。
3. 配对码 10 分钟有效，且仅可使用一次。

## 后台保活服务

可在 **保活** 页面或通过命令行安装系统后台服务：
- **Linux**：systemd 用户单元（开启 `loginctl enable-linger` 支持开机自启）
- **macOS**：LaunchAgent
- **其他**：内置守护进程

```bash
herdr-remote keepalive install | uninstall | restart | status
```

## 命令行常用命令

```bash
herdr-remote start | stop | restart
herdr-remote status [--json]
herdr-remote pair [--json]
herdr-remote url
herdr-remote plugin link | unlink | status
herdr-remote --lang zh|en
```

## 注册 Herdr 插件

将本包注册为 Herdr 原生插件：

```bash
herdr-remote plugin link
```

## 配置文件

配置文件路径：`~/.config/herdr-remote/config.json`

```json
{
  "ui":        { "language": "auto" },
  "relay":     { "mode": "local", "port": 8787, "lanHost": "", "publicUrl": "", "remoteUrl": "" },
  "herdr":     { "socketPath": null, "args": [] },
  "keepalive": { "manager": "auto" }
}
```

主机身份令牌与密钥单独保存在 `~/.local/state/herdr-remote/runtime.json`（权限 `0600`）。

## 安全机制

- Relay 仅转发 WebSocket 数据流，不执行 Shell，不直接访问宿主机套接字。
- 设备令牌只绑定一个工作站；`/api/status` 按工作站隔离，普通用户不能枚举或查看其他 Herdr 实例，relay 全局状态仅对管理员令牌开放。
- 认证令牌保存为 SHA-256 哈希；终端输出内容永不落盘。
- 每个已配对窗口各自拥有一个终端，均可输入；权限边界是配对本身，而非控制权租约。
- 一次性配对码设有限频与 10 分钟过期机制。

## 开发

```bash
npm install
npm run build      # 编译 WebUI 与 TUI
npm test           # 运行 relay 与 CLI 测试
npm run test:web   # 运行 WebUI 测试
npm run typecheck  # TypeScript 类型检查
```

## 开源协议

MIT
