# Lotus-Yunzai · OPQBot 协议适配器

提供 OPQBot 反向 WebSocket 适配器，运行于 Bun 1.4.4。包入口是 `@lotus-yunzai/opq` 的 `createOpqAdapter({ instance, accounts })`。

宿主通过 `start` 注册消息处理器。反向 WebSocket 应由宿主完成鉴权后交给 `accept`，并将连接的消息与断开分别交给返回会话的 `receive` 与 `close`。账号只接受 `accounts` 中登记的 QQ 号字符串。沿用旧入口时，由宿主挂载 `/OPQBot`，OPQBot 端以 `-wsserver` 指向该地址。

| 方向 | 支持 |
| --- | --- |
| 接收 | 成功登录事件，好友、群聊和可识别群号的临时会话消息，文字、提及和 QQ CDN 图片 |
| 发送 | 好友、群聊和临时会话的文字、图片与语音，群成员提及与本连接内的群消息引用 |
| 回执 | 仅在协议明确回执时确认成功。有原生消息 UID 时返回准确的 UID |

图片和语音按字节传入，单个媒体上限为 10 MiB。视频、文件、平台通讯录、群管理、群通知与合并转发暂不支持。

## 开发验证

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

随仓[纯协议测试](test/protocol.test.ts)覆盖消息字段、群引用的 64 位 ID、媒体限制和回执判定，无需启动 OPQBot。

## 来源

协议行为参考 [TRSS Yunzai 的旧 OPQBot 适配器](https://github.com/TimeRainStarSky/Yunzai/blob/d94cb7f884b13206649b48701b1a9a5d47a2e2f4/plugins/adapter/OPQBot.js)、[OPQBot WebSocket 文档](https://s.apifox.cn/267d34cb-357b-49a5-b637-493463090bf0/doc-3097871)及[消息事件文档](https://s.apifox.cn/267d34cb-357b-49a5-b637-493463090bf0/doc-2284379)。
