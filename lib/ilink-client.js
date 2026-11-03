/**
 * iLink Bot protocol client for Tencent ClawBot (WeChat personal-account bot).
 *
 * Pure HTTP/JSON over Node's global fetch; no third-party dependency.
 * Protocol baseline: @tencent-weixin/openclaw-weixin 2.4.6.
 *
 * Every request after login carries:
 *   Content-Type: application/json
 *   AuthorizationType: ilink_bot_token
 *   X-WECHAT-UIN: base64(String(random uint32))    // anti-replay, per request
 *   iLink-App-Id: bot
 *   iLink-App-ClientVersion: 132102
 *   Authorization: Bearer <bot_token>
 *
 * Every POST body additionally carries `base_info`.
 */

/** Initial host; a confirmed login may redirect to the `baseurl` it returns. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Business codes that mean the bot token is no longer usable. */
const TOKEN_INVALID_CODES = new Set([-14]);

/** Default per-request timeout for ordinary (non-long-poll) calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** Default long-poll hold, used when the server omits `longpolling_timeout_ms`. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/** Grace added on top of the server-declared long-poll hold. */
const LONG_POLL_GRACE_MS = 10_000;

/**
 * A rejected iLink call carrying the business code, so callers can branch on
 * token expiry without parsing messages.
 */
export class IlinkError extends Error {
  /**
   * @param {string} message human-readable failure
   * @param {{ code?: number, endpoint?: string, retryable?: boolean }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'IlinkError';
    this.code = info.code;
    this.endpoint = info.endpoint;
    this.retryable = info.retryable ?? false;
  }

  /** Whether this failure means the stored bot token must be discarded. */
  get isTokenInvalid() {
    return this.code !== undefined && TOKEN_INVALID_CODES.has(this.code);
  }
}

/** Build the anti-replay header value: base64 of a random uint32 in decimal. */
function wechatUin() {
  const value = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/** Extract `ret` / `errcode` from a decoded response body. */
function businessCode(body) {
  if (body === null || typeof body !== 'object') return undefined;
  if (typeof body.ret === 'number') return body.ret;
  if (typeof body.errcode === 'number') return body.errcode;
  return undefined;
}

/** Resolve the first text part of one inbound message, if any. */
export function messageText(message) {
  const items = message?.item_list;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      return item.text_item.text;
    }
  }
  return undefined;
}

export class IlinkClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] initial host
   * @param {string} [options.botToken] stored Bearer token, when already paired
   * @param {string} [options.channelVersion] reported protocol version
   * @param {string} [options.botAgent] reported agent identity
   * @param {number} [options.requestTimeoutMs] ordinary call timeout
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.botToken = options.botToken ?? null;
    this.channelVersion = options.channelVersion ?? '2.4.6';
    this.botAgent = options.botAgent ?? 'dsh-wechat-remote/1.0.0';
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Whether a token is currently installed. */
  get paired() {
    return typeof this.botToken === 'string' && this.botToken.length > 0;
  }

  /** Install a confirmed token and its redirect host. */
  adopt({ botToken, baseUrl }) {
    if (typeof botToken === 'string' && botToken.length > 0) this.botToken = botToken;
    if (typeof baseUrl === 'string' && baseUrl.length > 0) this.baseUrl = baseUrl;
  }

  /** Drop the token; the next authenticated call fails until re-login. */
  forget() {
    this.botToken = null;
  }

  /** Assemble headers for one call. */
  #headers({ authenticated }) {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': wechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132102',
    };
    if (authenticated) headers.Authorization = `Bearer ${this.botToken}`;
    return headers;
  }

  /** Request body envelope shared by every POST. */
  #envelope(extra) {
    return {
      ...extra,
      base_info: {
        channel_version: this.channelVersion,
        bot_agent: this.botAgent,
      },
    };
  }

  /**
   * Perform one HTTP call and decode its JSON body, mapping transport and
   * business failures onto {@link IlinkError}.
   *
   * @param {string} endpoint path beginning with `/ilink/bot/`
   * @param {object} options
   * @param {'GET'|'POST'} [options.method]
   * @param {Record<string, string>} [options.query]
   * @param {object} [options.body]
   * @param {boolean} [options.authenticated]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<any>} decoded body
   */
  async #call(endpoint, options = {}) {
    const {
      method = 'POST',
      query,
      body,
      authenticated = true,
      timeoutMs = this.requestTimeoutMs,
      signal,
    } = options;

    if (authenticated && !this.paired) {
      throw new IlinkError(`not paired: ${endpoint} requires a bot token`, {
        endpoint,
        code: -14,
      });
    }

    const url = new URL(endpoint, this.baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: this.#headers({ authenticated }),
        body: method === 'POST' ? JSON.stringify(this.#envelope(body ?? {})) : undefined,
        signal: combined,
        redirect: 'follow',
      });
    } catch (error) {
      if (combined.aborted && !signal?.aborted) {
        throw new IlinkError(`${endpoint} timed out after ${timeoutMs}ms`, {
          endpoint,
          retryable: true,
        });
      }
      throw new IlinkError(`${endpoint} transport failure: ${error?.message ?? String(error)}`, {
        endpoint,
        retryable: true,
      });
    }

    const raw = await response.text();
    let decoded;
    try {
      decoded = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      throw new IlinkError(
        `${endpoint} returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 160)}`,
        { endpoint, retryable: response.status >= 500 },
      );
    }

    const code = businessCode(decoded);
    if (code !== undefined && code !== 0) {
      throw new IlinkError(`${endpoint} rejected with code ${code}`, {
        endpoint,
        code,
        retryable: code !== -14 && response.status >= 500,
      });
    }
    if (!response.ok) {
      throw new IlinkError(`${endpoint} failed with HTTP ${response.status}`, {
        endpoint,
        code,
        retryable: response.status >= 500,
      });
    }
    return decoded;
  }

  /**
   * Request a login QR code.
   *
   * `qrcodeImgContent` is the WeChat lite-app **link** the phone opens after the
   * scan (`https://liteapp.weixin.qq.com/q/…?qrcode=…&bot_type=3`), not image
   * bytes — it is the QR payload, and `lib/qr-image.js` turns it into a picture.
   *
   * @param {string[]} [localTokenList] previously held tokens (up to 10) to allow silent reuse
   * @returns {Promise<{ qrcode: string, qrcodeImgContent: string }>}
   */
  async getBotQrcode(localTokenList = []) {
    const query = { bot_type: 3 };
    const body = Array.isArray(localTokenList) && localTokenList.length > 0
      ? { local_token_list: localTokenList.slice(0, 10) }
      : {};
    const decoded = await this.#call('/ilink/bot/get_bot_qrcode', {
      method: 'POST',
      query,
      body,
      authenticated: false,
    });
    const qrcode = decoded.qrcode ?? decoded.qr_code;
    if (typeof qrcode !== 'string' || qrcode.length === 0) {
      throw new IlinkError('get_bot_qrcode returned no qrcode', {
        endpoint: '/ilink/bot/get_bot_qrcode',
      });
    }
    return {
      qrcode,
      qrcodeImgContent: decoded.qrcode_img_content ?? decoded.qrcode_img ?? '',
    };
  }

  /**
   * Poll one QR-code state transition.
   *
   * When Tencent asks for the phone-displayed pairing code (`need_verifycode`),
   * the code rides on the next status poll: the documented endpoint set has no
   * separate verify endpoint, so it is passed as an extra query parameter and
   * ignored by a server that does not expect it.
   *
   * @param {string} qrcode value returned by {@link getBotQrcode}
   * @param {AbortSignal} [signal]
   * @param {string} [verifyCode] numeric pairing code to submit with this poll
   * @returns {Promise<{ status: string, botToken?: string, baseUrl?: string, accountId?: string }>}
   */
  async getQrcodeStatus(qrcode, signal, verifyCode) {
    const query = { qrcode };
    if (typeof verifyCode === 'string' && verifyCode.length > 0) {
      query.verify_code = verifyCode;
    }
    const decoded = await this.#call('/ilink/bot/get_qrcode_status', {
      method: 'GET',
      query,
      authenticated: false,
      signal,
    });
    const status = decoded.status ?? decoded.state ?? 'wait';
    return {
      status,
      ...decoded.bot_token === undefined ? {} : { botToken: decoded.bot_token },
      ...decoded.baseurl === undefined ? {} : { baseUrl: decoded.baseurl },
      ...decoded.account_id === undefined ? {} : { accountId: decoded.account_id },
    };
  }

  /**
   * Long-poll for inbound messages.
   * @param {object} options
   * @param {string} options.cursor previous `get_updates_buf` (empty string on first call)
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ messages: object[], cursor: string, holdMs: number }>}
   */
  async getUpdates({ cursor, signal }) {
    const holdMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    const decoded = await this.#call('/ilink/bot/getupdates', {
      body: { get_updates_buf: cursor ?? '' },
      timeoutMs: holdMs + LONG_POLL_GRACE_MS,
      signal,
    });
    const messages = Array.isArray(decoded.msgs) ? decoded.msgs : [];
    const nextCursor = typeof decoded.get_updates_buf === 'string'
      ? decoded.get_updates_buf
      : (cursor ?? '');
    const serverHold = typeof decoded.longpolling_timeout_ms === 'number'
      ? decoded.longpolling_timeout_ms
      : holdMs;
    return { messages, cursor: nextCursor, holdMs: serverHold };
  }

  /**
   * Send one text message into the conversation identified by `contextToken`.
   *
   * @param {object} options
   * @param {string} options.toUserId inbound `from_user_id`
   * @param {string} options.contextToken inbound `context_token`, returned verbatim
   * @param {string} options.text message body
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ clientId: string }>}
   */
  async sendText({ toUserId, contextToken, text, signal }) {
    const clientId = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const msg = {
      to_user_id: toUserId,
      message_type: 2,
      message_state: 2,
      client_id: clientId,
      item_list: [{ type: 1, text_item: { text } }],
    };
    if (typeof contextToken === 'string' && contextToken.length > 0) {
      msg.context_token = contextToken;
    }
    await this.#call('/ilink/bot/sendmessage', { body: { msg }, signal });
    return { clientId };
  }

  /**
   * Report the bot's typing state.
   * @param {{ status: 1 | 2, signal?: AbortSignal }} options 1 = typing, 2 = idle
   */
  async sendTyping({ status, signal }) {
    await this.#call('/ilink/bot/sendtyping', { body: { status }, signal });
  }

  /**
   * Fetch the bot configuration that carries `typing_ticket`.
   * @returns {Promise<{ typingTicket?: string }>}
   */
  async getConfig(signal) {
    const decoded = await this.#call('/ilink/bot/getconfig', { signal });
    return typeof decoded.typing_ticket === 'string'
      ? { typingTicket: decoded.typing_ticket }
      : {};
  }

  /**
   * Announce that the bot is online.
   * @returns {Promise<void>}
   */
  async notifyStart(signal) {
    await this.#call('/ilink/bot/msg/notifystart', { signal });
  }

  /**
   * Announce a clean shutdown. Best-effort: failures are swallowed by callers.
   * @returns {Promise<void>}
   */
  async notifyStop() {
    await this.#call('/ilink/bot/msg/notifystop', { timeoutMs: 5_000 });
  }
}
