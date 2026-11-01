# codex-weixin

[![CI](https://github.com/uk0/codex-weixin/actions/workflows/ci.yml/badge.svg)](https://github.com/uk0/codex-weixin/actions/workflows/ci.yml)

**微信作为通道，Codex 负责执行。** Independent Weixin ↔ Codex CLI bridge.

通过微信向自己电脑上的 Codex 发送任务、管理已接入会话、处理单次审批并接收文件。
不依赖 OpenClaw；不是腾讯或 OpenAI 官方产品，也不是 Codex 插件市场中的插件。

> **v0.5.1 公开预览版**。当前通过 GitHub 分发，未发布到 npm registry。
> 不承诺全部桌面/IDE 私有会话、GUI 工具或所有平台兼容。详细边界见下文。

## 快速开始

准备：Node.js **≥ 22.13**（含 npm/npx）、已安装并完成登录的 Codex CLI、自己的微信账号。
安装器会检查 `codex --version`，但不会替你购买或配置模型访问权限。

### 1. 安装并扫码

先进入你希望 Codex 使用的项目目录，再运行：

```bash
npx -y --package=https://github.com/uk0/codex-weixin/releases/download/v0.5.1/codex-weixin-cli-0.5.1.tgz codex-weixin install --workspace "$PWD" --new-workspace "$PWD"
```

安装器在终端显示二维码，使用自己的微信扫码。若提示验证码，按终端提示填写。
不要分享二维码、验证码或本地状态文件。

也可以从 Git 标签安装（需 Git）：

```bash
npx -y --package=github:uk0/codex-weixin#v0.5.1 codex-weixin install --workspace "$PWD" --new-workspace "$PWD"
```

默认只读。若确实需要让新会话修改项目文件，在**首次安装时**额外传入 `--workspace-write`。
安装器拒绝覆盖已存在配置；重复执行安装不是升级方式。

### 2. 启动通道

使用安装完成后打印的启动命令。默认数据目录对应：

```bash
node "$HOME/.local/share/codex-weixin/runtime/bin/codex-weixin.js" start --control
```

保持此进程及电脑运行；关闭、睡眠或断网会中断通道。本项目不自动安装开机自启服务。
也可首次安装加 `--start`，扫码后直接以前台方式启动。

### 3. 在微信中发送

```text
/n
```

然后直接说任务，例如：

- “看一下当前所有项目和所有 session，用 Markdown 列出来。”
- “搜索这个库的官方用法，附上来源链接。”
- “把当前项目里的 report.pdf 发给我确认。”

新会话注册通道工具，由 Codex 决定何时查询目录或发送文件。桥接不会凭自然语言关键词
自行执行文件发送，也不会把“好的”当作审批。历史会话未注册工具时，可以用显式命令管理。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/h`、`/h all` | 简洁/完整帮助 |
| `/n` | 新会话；默认目录见下方说明 |
| `/s`、`/s next` | 已连接后端可见的会话目录及下一页 |
| `/p` | 已配置项目、可见工作区和限定范围目录候选 |
| `/u 3` | 切换到目录第 3 项 |
| `/st`、`/hist` | 状态、会话历史 |
| `/f report.pdf` | 发送当前工作目录内的文件 |
| `/ok 确认码`、`/no 确认码` | 单次批准/拒绝 |
| `/+ 补充要求`、`/q` | 追加指令/请求中断 |
| `/more` | 读取长结果后续内容，不重跑任务 |

确认与审批提示使用 Markdown 分段，每条需发送的命令独占代码块。
搜索链接保留为普通 Markdown 链接。具体视觉排版/复制功能由微信客户端决定。

## 目录、数据与权限

- `--workspace`：初始工作目录；默认安装命令执行时所在目录。
- `--new-workspace`：新会话目录；未指定时优先使用已存在的 `~/Desktop/Codex`，否则使用工作目录。
  上面的快速安装命令显式设置两者，避免在另一目录开始任务。
- 数据及持久运行时默认保存在 `~/.local/share/codex-weixin`，不依赖临时 npx 缓存。
  自定义数据目录用 `--state-dir` 或 `CODEX_WEIXIN_HOME`。
- 只接收本机白名单中的微信用户；扫码账号会加入白名单。默认只读，不修改全局 Codex 配置。
- **Codex 沙箱不等于已有 MCP/插件的外部操作权限边界。** 只绑定自己控制的微信账号，
  并审查现有 Codex 插件及服务的权限。
- 文件仅可从当前会话工作目录读取普通文件，单个 ≤10 MiB；禁止越界路径、隐藏文件、
  私钥/凭据及符号链接等。API 接受发送不等于用户已经下载。
- 120 秒确认码、用户/目标绑定及单次审批保留；重启后的旧确认码不可继续使用。

## 兼容性与限制

- 历史开发验证使用 Codex CLI **0.166.0**；依赖 App Server 实验协议，其他版本需自行验证。
- macOS 有本地运行验证。Linux 的自动测试/安装检查不等于真实微信与 Codex 全链路验证；
  Windows 未完成支持验证。各次 CI 结果可在 Actions 查看。
- 仅已连接、支持附加的后端可实时控制；私有桌面/IDE 后端不能因历史可见就被接管。
- 不自动启动共享 Codex daemon，不迁移或重启其他客户端。
- 微信入站目前仅支持纯文本任务；不是群聊、图片理解、语音或远程桌面实现。
- 微信服务可用性、账户接入资格与第三方客户端政策由服务方决定，项目不作保证。
- 发送超时可能结果未知；不盲目重跑模型任务，不声称远端具备严格 exactly-once 投递保证。

## 从源码开发

```bash
git clone https://github.com/uk0/codex-weixin.git
cd codex-weixin
npm ci --ignore-scripts
npm run check
npm run release:check
npm pack --ignore-scripts
```

模拟测试不需要真实微信、Codex 登录或模型调用。详见 [测试说明](docs/TESTING.md)。
真实服务验证需要自己的账号，不要将登录数据或实际会话记录提交到仓库。

## 文档

- [CLI 与会话控制](docs/CLI.md)
- [架构与安全边界](docs/ARCHITECTURE.md)
- [安全报告与隐私](SECURITY.md)
- [发布说明](CHANGELOG.md)

许可证：MIT。协议参考与依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
