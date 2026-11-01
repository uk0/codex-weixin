# 架构与边界

```text
白名单微信用户
    ↓ iLink getupdates
Bridge（去重、持久状态、串行发送队列）
    ↓ 普通任务 / 明确管理命令
SessionController → Codex App Server（stdio / Unix socket / 认证 WebSocket）
    ↑ 最终回答、审批、动态工具
    ↓ 微信 text_item / 加密 CDN 附件
白名单微信用户
```

## 模型与通道的分工

Codex 决定怎样完成任务、何时查询会话目录或发送文件。新线程注册五个受限工具：
`weixin_send_file`、`weixin_send_text`、`weixin_list_sessions`、`weixin_list_projects`、
`weixin_select_session`。工具响应区分入队、API 接受、失败/未知结果；不把入队当成发送成功。
既有历史会话不注入工具或复制上下文，管理命令仍可用。

## 关键模块

- `lib/bridge.js`：白名单、入站去重、durable outbox、独立轮询和发送泵。
- `lib/codex.js`：App Server 初始化、RPC 与 turn 事件关联、超时/断连。
- `lib/sessions.js`：已接入后端会话控制、一次性确认、审批与工具路由。
- `lib/catalog.js`：有界分页、快照、部分结果标识，不以第一页冒充全部。
- `lib/files.js`：工作目录边界检查、文件快照与交付元数据。
- `lib/presentation.js`：UTF-8 安全 Markdown 分段、链接/围栏/表格与续页。
- `lib/messages.js`：内置控制消息的标题、短段落与独立可复制命令。
- `lib/store.js`：本机私有文件权限、原子写入、独占锁。

## 不变量与限制

1. 未授权的发送者、群聊、未完成消息及不支持的媒体不能启动任务。
2. 非确定性的执行中断不自动重跑 Codex；发送重试保留消息 ID，但服务端超时后的去重保证未知。
3. 审批绑定具体请求及用户；其他客户端私有工具请求不能被桥接抢答。
4. 符号链接、越界路径、隐藏/凭据文件等不能通过发文件接口读取；远端文件不能冒充本机路径。
5. 历史可见不是实时所有权证明；冲突后端拒绝双重控制。
6. read-only 不自动约束已有 MCP 服务在外部系统的权限，用户仍须审查这些集成。
7. 本工具不是远程桌面、沙箱替代品或 Codex 全功能克隆；端到端兼容需要真实环境验证。
