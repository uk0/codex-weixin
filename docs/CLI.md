# CLI 与会话控制

`codex-weixin --help` 显示安装器支持的参数。安装后建议使用输出的持久运行时命令，
而不是每次都从远端重新下载代码。以下命令中的路径和名称是示例，需按实际环境替换。

## 本机命令

| 子命令 | 行为 |
| --- | --- |
| `install` | 检查 Codex，复制持久运行时，保存配置并扫码；拒绝覆盖已有配置 |
| `login` | 扫码授权；不能无声更换既有 bot 身份 |
| `start --control` | 前台运行多会话桥接；Ctrl+C 停止桥接，不停止共享 daemon |
| `status` | 本地配置状态；不是网络健康检查 |
| `doctor` | 检查 Codex App Server 握手；不调用模型、不验证微信收发 |
| `backend-add` | 注册一个已经存在的受支持后端入口 |
| `project-add` | 注册一个可明确选择的新会话工作区 |

安装参数：`--workspace PATH`、`--new-workspace PATH`、`--codex PATH`、`--model NAME`、
`--workspace-write`、`--no-login`、`--start`、`--allow-user USER_ID`。
通用参数：`--state-dir PATH`。数据目录必须只用于一个 bot。

注册后端/项目需要先停止桥接；配置变更使用同一把独占锁，避免并发覆盖。

```bash
node "$HOME/.local/share/codex-weixin/runtime/bin/codex-weixin.js" project-add --name demo --workspace /absolute/project
```

Unix socket 后端：`backend-add --name extra --endpoint unix:///absolute/socket`。
远端后端必须 `wss://` 并使用 `--token-env ENV_NAME`；配置仅保存变量名，不将 token 放进 URL。
这不会自动让没有附加接口的桌面/IDE 后端变得可控。

## 微信命令

- `/sessions [next|archived|搜索词]`（`/s`）、`/projects`（`/p`）
- `/use 编号`（`/u`）或 `/use 后端:会话ID`、`/status`（`/st`）
- `/new [项目名]`（`/n`）、`/history [next]`（`/hist`）
- `/watch`、`/unwatch`、`/steer 指令`（`/+`）、`/stop`（`/q`）
- `/files`、`/send 相对路径或编号`（`/f`）、`/more [码]`
- `/approvals`（`/a`）、`/approve 码`（`/ok`）、`/decline 码`（`/no`）
- `/answer 码 JSON`：按请求的问题 ID 或 schema 填写，不会代填凭据或 URL 授权
- `/models`、`/model ID`、`/effort 档位`、`/skills`、`/mcp`
- `/rename 名称`、`/fork`、`/backends`、`/help [all]`（`/h`）
- `/resume`、`/archive`、`/unarchive`、`/delete`：先申请确认，再发送对应 `/confirm 码`

恢复历史会话前，用户必须核实该会话没有在未接入的私有客户端执行，避免两个执行者。
验证码 120 秒有效，绑定用户/目标，切换目标或重启桥接后失效。审批超时默认拒绝。
长命令与短命令等价；普通自然语言任务原样交给 Codex，不通过关键词代替模型执行。

## 升级与排错

当前没有无人值守的自动升级命令。**不要删除状态目录以绕过 Already configured**，
也不要复制其他人的 account/config/state 文件。维护前先等当前任务与发送队列结束，
停止桥接，在本机私有位置备份数据，再按版本迁移说明更新；公开版本尚无通用自动迁移器。

- 控制请求失败：先 `/st` 和 `/backends`，再在本机检查 Codex。
- 文件失败：确认路径/大小/权限，先检查微信是否已经收到；不盲目重复发送。
- `Bridge is locked`：先确认无桥接进程仍在运行，才可人工处理陈旧锁。
- `status` 只读本地配置；`doctor` 只证明握手；都不等于微信实际收件验证。

默认 Markdown；确有纯文本客户端兼容需要时，可在停机后将本地 config.json 中
`messageFormat` 设置为 `plain`。这不是 Markdown 渲染服务，客户端显示仍需实测。
