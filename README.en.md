# dsh-wechat-remote

[中文说明](README.md) · English

Turn a personal WeChat account into a remote control **and a monitor** for
[DeepSeek Harness](https://github.com/deepseek-ai) (DSH): watch a long job from
your phone, send the next instruction, take over the conversation.

Pairing goes through Tencent's official ClawBot (iLink) protocol — no
third-party hooks, no unofficial clients.

```
WeChat ──getupdates──▶ Runtime ──▶ CommandRouter ──▶ SessionAttach(prompt)
                        │                              │
                        │                    follow(): assistant prose
                        ▼                              ▼
                     Outbox ◀── ProgressPusher ◀── ProgressTracker
                        │       (session/event · every session)
                        ▼
                  sendmessage ──▶ phone
```

## What it fixes

Mirroring only assistant prose means a session that spends four minutes thinking
and running twenty tools looks exactly like a session that died. And requiring a
binding command before the first message means "just look at what my desktop is
doing" needs setup *while you are already walking out the door*.

So this plugin separates three things that used to be one:

| concept | meaning |
|---|---|
| `currents` | which session plain text on the phone is sent to |
| `watches` | which sessions push their progress to that phone |
| `notify` | which classes of notification are delivered |

and it collects progress from the **global** session event feed, so every
session is visible — including the one you never opened from the phone.

## On the phone

| you send | what happens |
|---|---|
| any text | goes to the current session (adopted automatically if unset) |
| `/t` | progress snapshot: running for how long, last actions, last output |
| `/ls` → `/open 2` | list sessions, switch |
| `/watch [n\|off]` | subscribe/unsubscribe a session's progress |
| `/new [title]`, `/ws …`, `/close`, `/stop`, `/status`, `/notify …`, `/help` | the occasional ones |

Away from the desk, all three cases have an answer:

1. **You started a long job and left** — no command needed first: the running
   session reports its actions. The plugin looks every 15s and speaks to one user
   at most every 45s; actions accumulated inside that gap are merged into the
   next message rather than dropped.
2. **It goes quiet** — after 2 minutes without an event you get one "still
   running" line instead of silence that looks like death.
3. **It finishes** — you get "✅ <session> finished this turn" with the closing
   message, and if that push was never actually shown (see below) it is repeated
   the next time you say anything.

## Install

Install this directory as a DSH bundle:

```
plugin_manager install_bundle  /absolute/path/to/dsh-wechat-remote
```

Then open **Settings → Plugins → WeChat Remote**, click **Sign in again**, and
scan the QR code with your phone. The **Send a test message to WeChat** button
tells you whether pushes can land right now.

No dependencies, no build step. Node >= 20.3 (uses `AbortSignal.any`).

## Why pushes are best-effort (and pulls are not)

iLink attaches an outbound message to the conversation window opened by *your
own* message (`context_token`). That has two consequences, both of which are
handled rather than hidden:

- **The window can be missing** (a restart, a long silence). Nothing is lost:
  the window token is persisted, undeliverable bodies are queued in order, and
  they are delivered as a `📬 backlog` right after your next command's reply.
  This matches the known WeChat-side issue tracked in OpenClaw
  ([#91887](https://github.com/openclaw/openclaw/issues/91887)).
- **A proactive send can be accepted and still not be seen**
  ([OpenClaw #79293](https://github.com/openclaw/openclaw/issues/79293)). So
  "sent" is never treated as "seen": a completion push is recorded as
  unacknowledged until you speak again, and the panel reports the push channel
  as `Ready` or `Waiting for your next message` instead of guessing.

The pull path (`/t`, `/status`) depends on none of that, which is why it exists.

## Design notes

- **Activity lines are a projection, not a copy.** One line per tool call: tool
  name plus a single key argument (`read` → `file_path`, `pwsh` → `command`,
  `grep` → `pattern`), truncated, with bearer tokens, `sk-…`, `token=…` and
  `scheme://user:pass@host` masked before anything reaches a lock screen. Tool
  results and private arguments never travel. (Same trade-off as Hermes'
  [managed tool progress](https://github.com/NousResearch/hermes-agent/commit/61ccd894c3674d01a2fb95528217816bc4888d52).)
- **One outbound queue.** Ordering, throttling, merging, and the held-back
  backlog have exactly one owner, so a progress digest can never overtake the
  reply to the command that produced it.
- **`/t` works on cold sessions.** If the plugin loaded after a session did, the
  durable event prefix is replayed through the same renderer.
- **The QR code is a link, not an image.** `get_bot_qrcode` returns the WeChat
  lite-app URL; the plugin encodes it into an SVG data URI with its own
  ISO/IEC 18004 encoder (`lib/qr.js`) instead of pasting a URL into a PNG data
  URL and getting a blank white square.
- **No dependencies, no schema object.** The host half imports nothing, so the
  bundle installs from any directory; defaults live in `DEFAULTS` and are
  normalized by `resolveConfig`.
- **Prompt injection queues.** `sessionController.prompt({ mode: 'queue' })`
  waits behind the current turn, so desktop and phone cannot corrupt each other.

## Layout

```
lib/
  index.js            wiring: long-poll, progress tracking, pushing
  ilink-client.js     iLink protocol (QR login, long-poll, send, typing)
  state-store.js      durable state (token, cursor, currents, watches, queues)
  pairing.js          pairing state machine
  command-router.js   command parsing and routing
  session-attach.js   current-session binding and prose mirror
  progress.js         session events → phone-readable lines; `/t` rendering
  pusher.js           who is told what, how often, and the silence alarm
  outbox.js           the single outbound queue
  notification.js     completion / error / approval notifications
  runtime.js          long-poll loop, send path, window-token persistence
  control-routes.js   HTTP surface for the Settings panel
  qr.js, qr-image.js  self-contained QR encoder and link → picture
client.js             Settings panel (React)
test/                 offline harnesses
```

## Tests

```
npm test
```

Ten offline harnesses, 188 assertions: command routing, state migration,
progress rendering and cold replay, the outbound queue (ordering, merging,
held backlog, restart survival), progress pushing and rate limiting,
notifications, the iLink protocol against a local stub, the QR encoder against
golden matrices, session mirroring, and the panel rendered under a fake React.

Nothing in the suite touches a Tencent endpoint, and CI runs it on Node 20/22/24.

## Limits

- Text only; images, voice, and files get a capability notice.
- The computer must stay on.
- One personal WeChat account; group chats are not supported.
- Proactive pushes depend on the WeChat-side window, so pulls are always
  reliable while pushes are best-effort with a backlog.

## License

[MIT](LICENSE)
