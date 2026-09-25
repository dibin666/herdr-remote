# AGENTS.md

Herdr Remote：在浏览器（含手机）里操作 Herdr 工作区。npm workspaces 单仓，Node ≥ 22。

## 结构与数据流

```
Herdr ──unix socket── host connector (cli) ──WS /ws/host── relay ──WS /ws/client── 浏览器 (web)
```

| 目录 | 包 | 职责 |
|---|---|---|
| `packages/cli` | `herdr-remote`（npm） | `bin/` CLI 入口；`src/` 服务层与 host connector；`tui/` Ink 配置界面；`herdr-plugin.toml` 插件清单 |
| `packages/relay` | `herdr-remote-relay`（npm + 镜像） | WS 中继、HTTP API、托管 web 产物；`src/stream-frame.js` 定义线协议 |
| `packages/relay/web` | 私有 | React 19 + Vite + xterm.js 前端，随 relay 发布 |

协议细节见 `docs/protocol.md`。

## 命令（仓库根目录）

- `npm ci`：安装（node-pty 需要编译工具链）
- `npm run check`：Biome + 类型检查，提交前必跑
- `npm run test:all`：全部测试
  - 单个 cli/relay 测试：`node --test packages/relay/tests/x.test.js`
  - 单个 web 测试：`npm test -w herdr-remote-web -- src/test/x.test.ts`
- `npm run format`：自动格式化，并应用可自动修复的 lint
- `npm run knip`：列出未使用的文件、导出和依赖
- `npm run dev -w herdr-remote-web`：前端开发服务器，代理到 127.0.0.1:8787 的 relay

## 不变量

- 线协议只在 relay 定义，cli 通过 `herdr-remote-relay/protocol` 引用。改 JSON 消息时，relay、cli、web 的 `src/types/protocol.ts` 和 `docs/protocol.md` 要一起改。
- Herdr socket 路径和 host token 只存在于 host connector，绝不能发给浏览器。
- 依赖方向：cli → relay；web 只依赖 relay 的协议；relay 不依赖 cli。
- push master 会自动发布 npm 和镜像，所以只通过 PR 合并。不要手改 `version` 或 `herdr-plugin.toml` 里的版本号，CI 会自动升版本。
- `node bin/herdr-remote.js` 及其子命令是插件的对外接口，不能改名。
- 新增文案要同时加 en 和 zh（cli 在 `src/i18n/`，web 在 `src/i18n/`）；README 和 docs 的中英文版本要一起改。
- `dist/` 是构建产物，不提交。

## 写代码

- 格式和 lint 以 Biome 为准；写 `biome-ignore` 时必须注明原因。
- 源文件上限 500 行，Biome 会检查。`biome.json` 里的超长文件白名单只减不增：要给白名单里的文件加功能，先把它拆开。
- 不新建 `utils` 之类的杂物文件，代码放进它所属的功能目录。
- 写 helper 前先搜有没有现成的实现；只用一次的逻辑不要抽成函数。
- 常量名带单位后缀（`_MS`、`_BYTES`），数字字面量写成 `30_000` 这种形式。
- 不写空的 `catch`；确实要忽略错误时，注释说明原因。
- 注释只写"为什么"，保持简短；不复述代码，也不写修改历史。

## 测试

- 修 bug 时，先加一个修复前会失败的测试。
- cli、relay：用 `node:test` + `assert/strict`，测试放在各包的 `tests/`。用依赖注入和 `HERDR_REMOTE_CONFIG_DIR`、`HERDR_REMOTE_STATE_DIR` 做隔离，不要碰真实的 home 目录。
- web：用 vitest + Testing Library。`src/test/setup.ts` 全局 mock 了 WebSocket 和 xterm。`fixtures/screens/*.json` 由 `scripts/capture-herdr-screens.mjs` 生成，不要手改。

## 提交与 PR

- 提交信息用英文祈使句，首字母大写，描述用户能看到的结果，不加前缀和句号；正文写原因。
- 一个 PR 只做一件事，控制在 800 行以内；重构和行为改动分开提交。
- 用 merge commit 合并 PR（不要 squash），这样 `.git-blame-ignore-revs` 里记录的提交才能在 master 上保留。
