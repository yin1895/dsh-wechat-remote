# dsh-wechat-remote

[![test](https://github.com/yin1895/dsh-wechat-remote/actions/workflows/test.yml/badge.svg)](https://github.com/yin1895/dsh-wechat-remote/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

中文 · [English](README.en.md)

把个人微信变成 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的**遥控器 + 监视器**：出门在外看长任务跑到哪了、发下一条指令、接管正在进行的对话。

配对走腾讯官方 ClawBot（iLink）协议，不是第三方 hook，也不是非官方客户端。

```
微信 ──getupdates──▶ Runtime ──▶ CommandRouter ──▶ SessionAttach(prompt)
                       │                              │
                       │                     follow()：助手文字
                       ▼                              ▼
                    Outbox ◀── ProgressPusher ◀── ProgressTracker
                       │        （session/event · 覆盖每个会话）
                       ▼
                 sendmessage ──▶ 手机
```

## 它解决什么问题

只镜像助手文字的话，一个"想了 4 分钟、跑了 20 个工具"的会话在手机上和一个"已经死了"的会话长得完全一样；而"先绑定一个会话再说话"这条规矩，意味着你想看一眼电脑上在干什么，得在**已经出门的路上**做一次设置。

所以这个插件把原本挤在同一个绑定变量上的三件事拆开了：

| 概念 | 含义 |
|---|---|
| `currents` | 手机上直接发的文字，发给哪个会话 |
| `watches` | 哪些会话把进展推给这个手机 |
| `notify` | 哪些类别的通知要送达 |

并且进展采集来自**全局**的会话事件流，因此每个会话都可见——包括你从没在手机上打开过的那个。

## 手机上怎么用

| 你发 | 会发生什么 |
|---|---|
| 任意文字 | 发给当前会话（没选过就自动接入正在跑的那个，并回一句说明） |
| `/t` | 进度快照：跑了多久、最近做了什么、最后一段输出 |
| `/ls` → `/open 2` | 看会话列表、换一个会话 |
| `/watch [序号\|off]` | 订阅/取消某个会话的进展推送 |
| `/new [标题]`、`/ws …`、`/close`、`/stop`、`/status`、`/notify …`、`/help` | 偶尔才用的那些 |

### 出门后的三种情况都有答案

1. **在电脑上起了长任务然后出门** —— 不需要先在手机上做任何操作：正在运行的会话会自动推动作简报。插件每 15 秒看一次，但**同一用户最多每 45 秒收到一条**；间隔里攒下的动作会合并在下一条，不会丢。
2. **跑着跑着一句话都不说** —— 超过 2 分钟没有新事件会推一条"还在运行"，而不是让你怀疑它死了。
3. **跑完了** —— 推「✅ 会话名 完成了这一轮」并附最后一段输出；如果这条推送其实没显示给你，你下次说话时它会补一次。

## 安装

把本目录作为 bundle 安装（无依赖、无构建步骤）：

```
plugin_manager install_bundle  /本仓库的绝对路径
```

在「设置 → 插件 → 微信遥控」里点「重新登录」，用手机微信扫码。面板上的「发一条测试消息到微信」可以直接回答"现在推送能不能落到手机上"。

要求 Node >= 20.3（用到 `AbortSignal.any`）。

## 为什么"推"是尽力而为，"拉"不是

iLink 把出站消息挂到**你自己那条消息打开**的会话窗口上（`context_token`）。这带来两个后果，都被正面处理而不是藏起来：

- **窗口可能不存在**（重启、长时间沉默）。这时不会丢东西：窗口 token 会持久化，发不出去的消息按顺序留存，你下一句话到达时先回命令、紧跟一条 `📬 补发`。这与 OpenClaw 上关于微信侧主动推送的已知问题一致（[#91887](https://github.com/openclaw/openclaw/issues/91887)）。
- **主动发送可能被接受、但用户看不到**（[OpenClaw #79293](https://github.com/openclaw/openclaw/issues/79293)）。所以这里**不把"已发送"当作"已看到"**：完成推送会被记为未确认，直到你再次说话；面板把推送通道显示成`就绪 / 等你先发一条微信消息`，而不是替你做判断。

拉取路径（`/t`、`/status`）完全不依赖这些，所以它一直存在。

## 设计要点

- **动作行是投影，不是拷贝。** 每个工具调用一行：工具名 + 一个关键参数（`read` → `file_path`、`pwsh` → `command`、`grep` → `pattern`），超长截断，并且 `Bearer …`、`sk-…`、`token=…`、`scheme://user:pass@host` 这类凭据在上手机前就被打码。工具结果和私有参数不上手机。（与 Hermes 的 [managed tool progress](https://github.com/NousResearch/hermes-agent/commit/61ccd894c3674d01a2fb95528217816bc4888d52) 是同一个取舍。）
- **只有一个出口队列。** 顺序、节流、合并、失败留存都归 `outbox.js` 一个负责人，所以一条进展简报永远不会插队到它之前那条命令的回复前面。
- **冷会话也能 `/t`。** 插件启动晚于会话时，用同一套渲染重放 `sessionController.inspect()` 的持久事件前缀，不存在"这个会话我没见过"。
- **沉默也是信息。** 一段长思考原本和"死掉"长得一样，现在超过 2 分钟没有事件就有一条心跳。
- **二维码是链接，不是图片。** `get_bot_qrcode` 返回的是微信 liteapp 页面地址；插件用自带的 ISO/IEC 18004 编码器（`lib/qr.js`）把它画成 SVG data URI，而不是把 URL 塞进 `data:image/png;base64,…` 得到一块白方块。
- **没有依赖，也没有 schema 对象。** Host 半边不 import 任何第三方包，所以可以从任意目录安装；默认值放在 `DEFAULTS` 里由 `resolveConfig` 归一化。
- **注入走 inbox 队列。** `sessionController.prompt({ mode: 'queue' })` 排在当前 turn 之后，桌面端和微信端同时发消息会串行处理。
- **状态写入串行化。** 所有持久化经同一条 promise 链；v1 记录（`attachedSessions`）读入时自动迁移成 v2 的 `currents` + 自动订阅。

## 结构与数据流

```
lib/
  index.js            插件入口：装配各模块，启动长轮询、进度采集与推送
  ilink-client.js     iLink 协议（QR 登录、长轮询、发消息、typing）
  state-store.js      状态持久化（token、游标、当前会话、订阅、窗口 token、待补发）
  pairing.js          配对状态机
  command-router.js   微信命令解析与路由
  session-attach.js   当前会话绑定 + 助手文字镜像（只做 prose）
  progress.js         会话事件 → 手机可读的动作行；/t 的渲染（含冷会话回放）
  pusher.js           决定谁该收到什么进展、多久一次、静默告警
  outbox.js           唯一的出口队列：顺序、节流、合并、失败留存与补发
  notification.js     完成/报错/审批通知（带会话名与最后输出）
  runtime.js          长轮询循环、发送通道、窗口 token 持久化
  control-routes.js   面板用的 HTTP 接口
  http-util.js        JSON 请求/响应 helper
  qr.js               自带二维码编码器（ISO/IEC 18004，字节模式、纠错 M、版本 1-10）
  qr-image.js         把 iLink 的登录链接换成可渲染的图片
client.js             Settings 面板（React）
test/                 离线测试套件
testdata/qr-golden.json  二维码回归基准（由 python-qrcode 生成、cv2 解码验证）
```

## 测试

```
npm test
```

十个离线套件、188 条断言：命令路由与选择器、状态存储与 v1→v2 迁移、进展渲染与冷回放、出口队列（顺序/合并/留存/重启后补发）、进展推送与限频、通知、iLink 协议对本地 stub、二维码编码器对基准矩阵、会话文字镜像、以及假 React 下渲染的面板。

整套不触碰任何腾讯接口，CI 在 Node 20/22/24 上跑。

## 安全与隐私

- 仓库里没有任何凭据。配对得到的 bot token 存在 `<DSH_HOME>/wechat-remote/state.json`（Harness home 下，不在仓库里），`.gitignore` 也挡了一层。
- 上手机的内容只有：助手文字、动作行（已打码）、通知。工具结果与原始参数不出本机。
- 面板的控制接口挂在本地 Web 服务上，由 DSH 自身的浏览器信任校验保护。

## 限制

- 仅支持文字消息；图片/语音/文件会收到能力提示
- 电脑需保持开机
- 个人微信单账号，群聊不支持
- 主动推送依赖微信侧的会话窗口：拉取永远可靠，推送尽力而为并有留存补发

## 许可

[MIT](LICENSE)
