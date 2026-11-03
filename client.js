window.__ModuleLoader__.load({
  id: 'dsh-wechat-remote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'wechatRemote';
    const BASE = '/wechat-remote';

    /*
     * Dictionaries live here rather than in locale/*.json because a browser half
     * is served as one module: the loader gives a factory nothing but `require`
     * for the modules the host already registered, so a bundle cannot read a
     * sibling JSON file. Every shipped client bundle inlines its texts for the
     * same reason. `locale/panel-locale.mjs` fails the offline suite if these
     * two objects and locale/zh.json + locale/en.json ever disagree.
     */
    const ZH = {
      nav: '微信遥控',
      title: '微信遥控',
      intro: '配对后，手机上直接发文字就是发给当前会话；/t 看进展，/ls 换会话。',
      statusPaired: '已配对',
      statusUnpaired: '未配对',
      statusOnline: '在线',
      statusReconnecting: '重连中',
      statusOffline: '离线',
      account: '账号',
      accountUnknown: '微信 ClawBot',
      pairedAt: '配对时间',
      never: '—',
      actions: '操作',
      reconnect: '重新连接',
      relogin: '重新登录',
      unbind: '解绑',
      testPush: '发一条测试消息到微信',
      testPushSent: '已排队 {n} 条',
      testPushWaiting: '{n} 条会等你先发一条微信消息',
      testPushFailed: '发送失败',
      noRecipient: '还没有微信联系人给这个机器人发过消息',
      context: '当前上下文',
      workspace: '工作区',
      currentSession: '当前会话',
      attachedSessions: '已绑定会话',
      watchedSessions: '订阅进展的会话',
      runningSessions: '正在运行的会话',
      pendingQuestions: '待你确认',
      notifications: '推送到手机',
      notifyTurnEnd: '一轮完成时通知',
      notifyError: '出错时通知',
      notifyApproval: '需要你确认时通知',
      notifyProgress: '运行中的进展推送',
      notifyStream: '助手实时文字',
      connection: '连接信息',
      lastHeartbeat: '最后收到消息',
      longPolling: '消息接收',
      longPollingActive: '接收中',
      longPollingRetrying: '已断开，重试中',
      pushChannel: '推送通道',
      pushReady: '就绪',
      pushWaiting: '等你先发一条微信消息',
      heldMessages: '待补发消息',
      loading: '加载中…',
      qrcodeTitle: '微信扫码登录',
      waitingScan: '等待扫码…',
      scanned: '已扫码，请在手机上确认',
      needVerifyCode: '请输入手机显示的数字配对码',
      confirmed: '已确认',
      expired: '二维码已过期，请重新获取',
      saveFailed: '状态读取失败',
      close: '关闭',
      submit: '提交',
      verifyCodePlaceholder: '数字配对码',
      unbindConfirm: '确定解除微信配对？解绑后需要重新扫码才能继续使用。',
      cancel: '取消',
      confirm: '确定',
    };

    const EN = {
      nav: 'WeChat Remote',
      title: 'WeChat Remote',
      intro: 'Once paired, plain text on your phone goes to the current session; /t shows progress and /ls switches sessions.',
      statusPaired: 'Paired',
      statusUnpaired: 'Not paired',
      statusOnline: 'Online',
      statusReconnecting: 'Reconnecting',
      statusOffline: 'Offline',
      account: 'Account',
      accountUnknown: 'WeChat ClawBot',
      pairedAt: 'Paired at',
      never: '—',
      actions: 'Actions',
      reconnect: 'Reconnect',
      relogin: 'Sign in again',
      unbind: 'Unbind',
      testPush: 'Send a test message to WeChat',
      testPushSent: 'Queued {n} message(s)',
      testPushWaiting: '{n} will wait until you message the bot',
      testPushFailed: 'Could not send',
      noRecipient: 'Nobody has messaged this bot yet',
      context: 'Current context',
      workspace: 'Workspace',
      currentSession: 'Current session',
      attachedSessions: 'Bound sessions',
      watchedSessions: 'Watched sessions',
      runningSessions: 'Running sessions',
      pendingQuestions: 'Waiting on you',
      notifications: 'Push to phone',
      notifyTurnEnd: 'Turn finished',
      notifyError: 'Errors',
      notifyApproval: 'Needs your decision',
      notifyProgress: 'Progress while running',
      notifyStream: 'Live assistant text',
      connection: 'Connection',
      lastHeartbeat: 'Last message received',
      longPolling: 'Receiving',
      longPollingActive: 'Receiving',
      longPollingRetrying: 'Disconnected, retrying',
      pushChannel: 'Push channel',
      pushReady: 'Ready',
      pushWaiting: 'Waiting for your next message',
      heldMessages: 'Held messages',
      loading: 'Loading…',
      qrcodeTitle: 'Scan to sign in',
      waitingScan: 'Waiting for the scan…',
      scanned: 'Scanned — confirm on your phone',
      needVerifyCode: 'Enter the pairing code shown on your phone',
      confirmed: 'Confirmed',
      expired: 'The code expired, please request a new one',
      saveFailed: 'Could not read status',
      close: 'Close',
      submit: 'Submit',
      verifyCodePlaceholder: 'Pairing code',
      unbindConfirm: 'Unbind WeChat? You will have to scan again to use this bridge.',
      cancel: 'Cancel',
      confirm: 'OK',
    };

    /** Fetch one control route and unwrap its envelope. */
    async function call(name, init) {
      const response = await fetch(`${BASE}/${name}`, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload.ok !== true) {
        // Carry the machine-readable code: matching on a localized message would
        // break the moment either side is reworded.
        const failure = new Error(payload.error?.message ?? '请求失败');
        failure.code = payload.error?.code ?? 'unknown';
        throw failure;
      }
      return payload.value;
    }

    /** One labelled switch row. */
    function Toggle({ label, checked, onChange, disabled, t }) {
      return h('label', { className: 'wr-toggle' }, [
        h('input', {
          key: 'input',
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { key: 'label' }, label),
      ]);
    }

    /** One key/value info row. */
    function InfoRow({ label, value }) {
      return h('div', { className: 'wr-row' }, [
        h('span', { key: 'k', className: 'wr-key' }, label),
        h('span', { key: 'v', className: 'wr-value' }, value),
      ]);
    }

    function statusLabel(status, label) {
      switch (status) {
        case 'online': return { text: label('statusOnline', '在线'), tone: 'ok' };
        case 'reconnecting': return { text: label('statusReconnecting', '重连中'), tone: 'warn' };
        default: return { text: label('statusOffline', '离线'), tone: 'idle' };
      }
    }

    /** The WeChat Remote settings panel. */
    function WechatRemotePanel({ t }) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [qr, setQr] = React.useState(null);
      const [qrStatus, setQrStatus] = React.useState('');
      const [qrBroken, setQrBroken] = React.useState(false);
      const [verify, setVerify] = React.useState('');
      const [confirmUnbind, setConfirmUnbind] = React.useState(false);
      const [testResult, setTestResult] = React.useState(null);
      const pollRef = React.useRef(null);

      const label = (key, fallback) => {
        const value = typeof t === 'function' ? t(key) : undefined;
        return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback;
      };

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('status');
          setStatus(next);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          if (!alive) return;
          await refresh();
        };
        void tick();
        const timer = setInterval(tick, 5000);
        return () => {
          alive = false;
          clearInterval(timer);
          if (pollRef.current !== null) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        };
      }, [refresh]);

      const stopQrPolling = React.useCallback(() => {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      const beginRelogin = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const code = await call('relogin', { method: 'POST' });
          setQr(code);
          setQrBroken(false);
          setQrStatus('wait');
          setVerify('');
          stopQrPolling();
          pollRef.current = setInterval(async () => {
            try {
              const outcome = await call('qrcode-status', { method: 'POST' });
              setQrStatus(outcome.status ?? 'wait');
              if (typeof outcome.error === 'string' && outcome.error.length > 0) {
                setError(outcome.error);
              }
              if (outcome.paired === true || outcome.expired === true) {
                stopQrPolling();
                if (outcome.paired === true) {
                  setQr(null);
                  await refresh();
                }
              }
            } catch (cause) {
              setQrStatus('error');
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }, 2000);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [refresh, stopQrPolling]);

      const closeQr = React.useCallback(async () => {
        stopQrPolling();
        setQr(null);
        setQrStatus('');
        try {
          await call('cancel-relogin', { method: 'POST' });
        } catch {
          // Closing the modal is not worth surfacing a failure for.
        }
      }, [stopQrPolling]);

      const doReconnect = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          await call('reconnect', { method: 'POST' });
          await refresh();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [refresh]);

      const doUnbind = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          await call('unbind', { method: 'POST' });
          setConfirmUnbind(false);
          stopQrPolling();
          setQr(null);
          await refresh();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [refresh, stopQrPolling]);

      /**
       * Send one test message to WeChat.
       *
       * Whether a proactive push is actually shown cannot be confirmed from
       * here — iLink can accept a send and the user still sees nothing — so this
       * reports the one thing that *is* knowable: whether a delivery window is
       * open right now, and what happens if it is not.
       */
      const doTestPush = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        setTestResult(null);
        try {
          const result = await call('test-push', { method: 'POST' });
          const waiting = result.waitingForWindow ?? 0;
          const head = label('testPushSent', '已排队 {n} 条').replace('{n}', String(result.recipients ?? 0));
          setTestResult(waiting > 0
            ? `${head}；${label('testPushWaiting', '{n} 条会等你先发一条微信消息').replace('{n}', String(waiting))}`
            : head);
          await refresh();
        } catch (cause) {
          const code = cause?.code;
          setTestResult(
            code === 'no-recipient'
              ? label('noRecipient', '还没有微信联系人给这个机器人发过消息')
              : code === 'not-paired'
                ? label('statusUnpaired', '未配对')
                : `${label('testPushFailed', '发送失败')}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } finally {
          setBusy(false);
        }
      }, [refresh, label]);

      const setNotify = React.useCallback(async (key, value) => {        try {
          await call('notify', {
            method: 'POST',
            body: JSON.stringify({ key, value }),
          });
          await refresh();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [refresh]);

      const submitVerify = React.useCallback(async () => {
        if (verify.trim().length === 0) return;
        try {
          await call('verify-code', {
            method: 'POST',
            body: JSON.stringify({ code: verify.trim() }),
          });
          // The code rides the next status poll, so the input can clear now and
          // the status line reports the outcome.
          setVerify('');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [verify]);

      const tone = statusLabel(status?.connectionStatus, label);

      const statusCard = h('div', { className: 'wr-card', key: 'status' }, [
        h('div', { className: 'wr-card-head', key: 'head' }, [
          h('span', {
            key: 'badge',
            className: `wr-badge wr-badge-${status?.paired ? tone.tone : 'idle'}`,
          }, status?.paired ? label('statusPaired', '已配对') : label('statusUnpaired', '未配对')),
          h('span', { key: 'conn', className: 'wr-conn' }, tone.text),
        ]),
        h(InfoRow, {
          key: 'account',
          label: label('account', '账号'),
          value: status?.accountId ?? (status?.paired ? label('accountUnknown', '微信 ClawBot') : label('never', '—')),
        }),
        h(InfoRow, { key: 'paired-at', label: label('pairedAt', '配对时间'), value: formatTime(status?.pairedAt) }),
        status?.lastError ? h('div', { key: 'err', className: 'wr-error' }, status.lastError) : null,
      ]);

      const actionsCard = h('div', { className: 'wr-card', key: 'actions' }, [
        h('h3', { key: 'h' }, label('actions', '操作')),
        h('div', { className: 'wr-buttons', key: 'buttons' }, [
          h('button', {
            key: 'test',
            type: 'button',
            className: 'wr-btn wr-btn-primary',
            disabled: busy || status?.paired !== true,
            onClick: doTestPush,
          }, label('testPush', '发一条测试消息到微信')),
          h('button', {
            key: 'reconnect',
            type: 'button',
            className: 'wr-btn',
            disabled: busy || status?.paired !== true,
            onClick: doReconnect,
          }, label('reconnect', '重新连接')),
          h('button', {
            key: 'relogin',
            type: 'button',
            className: 'wr-btn',
            disabled: busy,
            onClick: beginRelogin,
          }, label('relogin', '重新登录')),
          h('button', {
            key: 'unbind',
            type: 'button',
            className: 'wr-btn wr-btn-danger',
            disabled: busy || status?.paired !== true,
            onClick: () => setConfirmUnbind(true),
          }, label('unbind', '解绑')),
        ]),
        testResult === null ? null : h('div', { key: 'test-result', className: 'wr-note' }, testResult),
      ]);

      const contextCard = h('div', { className: 'wr-card', key: 'context' }, [
        h('h3', { key: 'h' }, label('context', '当前上下文')),
        h(InfoRow, { key: 'ws', label: label('workspace', '工作区'), value: status?.currentWorkspaceName ?? label('never', '—') }),
        h(InfoRow, {
          key: 'session',
          label: label('currentSession', '当前会话'),
          value: status?.currentSessionName ?? status?.currentSessionId ?? label('never', '—'),
        }),
        h(InfoRow, { key: 'sessions', label: label('attachedSessions', '已绑定会话'), value: String(status?.attachedSessionCount ?? 0) }),
        h(InfoRow, { key: 'watched', label: label('watchedSessions', '订阅进展的会话'), value: String(status?.watchedSessionCount ?? 0) }),
        h(InfoRow, { key: 'running', label: label('runningSessions', '正在运行的会话'), value: String(status?.runningSessionCount ?? 0) }),
        h(InfoRow, { key: 'questions', label: label('pendingQuestions', '待你确认'), value: String(status?.pendingQuestionCount ?? 0) }),
      ]);

      const notifyCard = h('div', { className: 'wr-card', key: 'notify' }, [
        h('h3', { key: 'h' }, label('notifications', '推送到手机')),
        h(Toggle, {
          key: 'progress',
          label: label('notifyProgress', '运行中的进展推送'),
          checked: status?.notify?.progress,
          onChange: (value) => setNotify('progress', value),
        }),
        h(Toggle, {
          key: 'turn',
          label: label('notifyTurnEnd', '一轮完成时通知'),
          checked: status?.notify?.turnEnd,
          onChange: (value) => setNotify('turnEnd', value),
        }),
        h(Toggle, {
          key: 'stream',
          label: label('notifyStream', '助手实时文字'),
          checked: status?.notify?.stream,
          onChange: (value) => setNotify('stream', value),
        }),
        h(Toggle, {
          key: 'approval',
          label: label('notifyApproval', '需要你确认时通知'),
          checked: status?.notify?.approval,
          onChange: (value) => setNotify('approval', value),
        }),
        h(Toggle, {
          key: 'error',
          label: label('notifyError', '出错时通知'),
          checked: status?.notify?.error,
          onChange: (value) => setNotify('error', value),
        }),
      ]);

      const connectionCard = h('div', { className: 'wr-card', key: 'connection' }, [
        h('h3', { key: 'h' }, label('connection', '连接信息')),
        h(InfoRow, {
          key: 'heartbeat',
          label: label('lastHeartbeat', '最后收到消息'),
          value: formatTime(status?.lastHeartbeat),
        }),
        h(InfoRow, {
          key: 'poll',
          label: label('longPolling', '消息接收'),
          value: status?.longPollingActive
            ? label('longPollingActive', '接收中')
            : label('longPollingRetrying', '已断开，重试中'),
        }),
        h(InfoRow, {
          key: 'push',
          label: label('pushChannel', '推送通道'),
          value: status?.pushReachable
            ? label('pushReady', '就绪')
            : label('pushWaiting', '等你先发一条微信消息'),
        }),
        h(InfoRow, {
          key: 'held',
          label: label('heldMessages', '待补发消息'),
          value: String(status?.pendingOutCount ?? 0),
        }),
      ]);

      /*
       * The Host renders the QR picture: iLink's `qrcode_img_content` is the
       * WeChat lite-app link the phone opens, not image bytes, so it arrives
       * here as a ready-to-use data URI. A raw `data:` value still renders as
       * before, and anything else falls back to showing the link text rather
       * than an empty white square.
       */
      const qrImage = typeof qr?.qrcodeImage === 'string' && qr.qrcodeImage.length > 0
        ? qr.qrcodeImage
        : typeof qr?.qrcodeImgContent === 'string' && qr.qrcodeImgContent.startsWith('data:')
          ? qr.qrcodeImgContent
          : null;
      const qrFallback = qr?.qrcodeLink ?? qr?.qrcodeImgContent ?? qr?.qrcode ?? '';

      const qrModal = qr === null ? null : h('div', {
        key: 'modal',
        className: 'wr-modal-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
        onKeyDown: (event) => {
          if (event.key === 'Escape') void closeQr();
        },
      }, [
        h('div', { key: 'panel', className: 'wr-modal' }, [
          h('h3', { key: 'title' }, label('qrcodeTitle', '微信扫码登录')),
          qrImage !== null && qrBroken !== true
            ? h('img', {
              key: 'img',
              className: 'wr-qr',
              alt: 'WeChat login QR code',
              src: qrImage,
              onError: () => setQrBroken(true),
            })
            : h('div', { key: 'noimg', className: 'wr-error' }, qrFallback),
          qr?.qrcodeLink ? h('div', { key: 'link', className: 'wr-qr-link' }, qr.qrcodeLink) : null,
          h('div', { key: 'status', className: 'wr-qr-status' }, qrStatusText(qrStatus, label)),
          qrStatus === 'need_verifycode'
            ? h('div', { key: 'verify', className: 'wr-verify' }, [
              h('input', {
                key: 'input',
                type: 'text',
                inputMode: 'numeric',
                placeholder: label('verifyCodePlaceholder', '数字配对码'),
                value: verify,
                onChange: (event) => setVerify(event.target.value),
              }),
              h('button', {
                key: 'submit',
                type: 'button',
                className: 'wr-btn wr-btn-primary',
                onClick: submitVerify,
              }, label('submit', '提交')),
            ])
            : null,
          h('button', {
            key: 'close',
            type: 'button',
            className: 'wr-btn',
            onClick: closeQr,
          }, label('close', '关闭')),
        ]),
      ]);

      const confirmModal = confirmUnbind !== true ? null : h('div', {
        key: 'confirm',
        className: 'wr-modal-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
      }, [
        h('div', { key: 'panel', className: 'wr-modal' }, [
          h('h3', { key: 'title' }, label('unbind', '解绑')),
          h('p', { key: 'body' }, label('unbindConfirm', '确定解除微信配对？解绑后需要重新扫码才能继续使用。')),
          h('div', { key: 'buttons', className: 'wr-buttons' }, [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'wr-btn',
              onClick: () => setConfirmUnbind(false),
            }, label('cancel', '取消')),
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'wr-btn wr-btn-danger',
              onClick: doUnbind,
            }, label('confirm', '确定')),
          ]),
        ]),
      ]);

      return h('div', { className: 'wr-panel' }, [
        h('h2', { key: 'title', className: 'wr-title' }, label('title', '微信遥控')),
        h('p', { key: 'intro', className: 'wr-intro' }, label('intro', '配对后，手机上直接发文字就是发给当前会话；/t 看进展，/ls 换会话。')),
        error === null ? null : h('div', { key: 'error', className: 'wr-error' }, error),
        status === null
          ? h('div', { key: 'loading', className: 'wr-intro' }, label('loading', '加载中…'))
          : h(React.Fragment, null, [statusCard, actionsCard, contextCard, notifyCard, connectionCard]),
        qrModal,
        confirmModal,
      ]);
    }

    /** Render the QR status text. */
    function qrStatusText(status, label) {
      switch (status) {
        case 'scaned': return label('scanned', '已扫码，请在手机上确认');
        case 'need_verifycode': return label('needVerifyCode', '请输入手机显示的数字配对码');
        case 'confirmed': return label('confirmed', '已确认');
        case 'expired': return label('expired', '二维码已过期，请重新获取');
        case 'error': return label('saveFailed', '状态读取失败');
        default: return label('waitingScan', '等待扫码…');
      }
    }

    /** Format a millisecond timestamp for the panel. */
    function formatTime(value) {
      if (typeof value !== 'number' || value <= 0) return '—';
      const date = new Date(value);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** Panel-local styles, injected once per page. */
    const CSS = `
.wr-panel{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary)}
.wr-title{margin:0;font-size:18px;font-weight:600}
.wr-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.wr-card{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.wr-card h3{margin:0 0 2px;font-size:14px;font-weight:600}
.wr-card-head{display:flex;align-items:center;gap:10px}
.wr-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid transparent}
.wr-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.wr-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.wr-badge-idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l2)}
.wr-conn{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wr-row{display:flex;justify-content:space-between;gap:16px;font-size:13px;line-height:20px}
.wr-key{color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.wr-value{color:var(--dsw-alias-label-primary);text-align:right;word-break:break-all}
.wr-buttons{display:flex;flex-wrap:wrap;gap:8px}
.wr-btn{font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.wr-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.wr-btn:disabled{opacity:.5;cursor:default}
.wr-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wr-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.wr-toggle{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.wr-toggle input{accent-color:var(--dsw-alias-brand-primary)}
.wr-error{font-size:13px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.wr-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wr-modal-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:1000}
.wr-modal{display:flex;flex-direction:column;align-items:center;gap:12px;min-width:280px;max-width:360px;padding:20px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1)}
.wr-modal h3{margin:0;font-size:15px;font-weight:600}
.wr-modal p{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.wr-qr{width:220px;height:220px;object-fit:contain;background:#fff;border-radius:8px;padding:6px}
.wr-qr-link{max-width:280px;font-size:11px;line-height:15px;text-align:center;word-break:break-all;color:var(--dsw-alias-label-secondary);user-select:text;cursor:text}
.wr-qr-status{font-size:13px;color:var(--dsw-alias-label-secondary)}
.wr-verify{display:flex;gap:8px;align-items:center}
.wr-verify input{font:inherit;font-size:13px;padding:5px 9px;width:140px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Register before binding: an unregistered namespace resolves every key
        // to the key itself, so the tab label would read "nav".
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', ZH);
          const offEn = ctx.locale.register(NS, 'en', EN);
          return () => {
            offZh();
            offEn();
          };
        }, 'wechat-remote: dictionaries');

        const t = ctx.locale.bind(NS);

        /**
         * The `settings.plugins.tab` owner supplies no props, so the translator
         * is injected here. Subscribing to the locale revision re-renders the
         * panel after a language switch.
         */
        function Panel() {
          const [, setRevision] = React.useState(0);
          React.useEffect(
            () => ctx.locale.subscribe(() => setRevision((value) => value + 1)),
            [],
          );
          return h(WechatRemotePanel, { t });
        }

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => undefined;
          const tagId = 'dsh-wechat-remote/panel.css';
          if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) {
            return () => undefined;
          }
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-wechat-remote';
          tag.dataset.pluginCss = tagId;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'wechat-remote: panel styles');

        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'wechat-remote',
          order: 20,
          label: () => t('nav'),
        }, Panel));
      },
    };
  },
});
