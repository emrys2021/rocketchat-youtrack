import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { log, errorToMeta } from './logger.js';
import { isAutoReplyText, isSystemMessageType } from './message-filters.js';

/**
 * Rocket.Chat Realtime (DDP over WebSocket) client.
 *
 * 负责：
 *   1. 连接 ws(s)://<host>/websocket，完成 DDP connect 握手；
 *   2. 用 username/password 或显式的 DDP resume token 完成 DDP login；
 *   3. 订阅 stream-room-messages 的 __my_messages__ 通配流（覆盖私信 DM 和频道）；
 *   4. 把收到的新消息以 'message' 事件抛给上层（bot-runner）；
 *   5. 断线后按指数退避自动重连。
 *
 * 只读 / 接收用途。回复仍然通过 REST 的 RocketClient.postMessage 发送，
 * 这样可以复用现有的分段发送与线程回复逻辑。
 */
export class RocketRealtimeClient extends EventEmitter {
  constructor(options) {
    super();
    this.baseUrl = (options.url || '').replace(/\/$/, '');
    this.userId = options.userId || '';
    this.resumeToken = options.resumeToken || '';
    this.username = options.username || '';
    this.password = options.password || '';
    this.heartbeatMs = options.heartbeatMs || 25000;
    // 退避上限给到 60 秒：遇到 error-login-blocked-for-ip 这类登录限流时，
    // 最长 60 秒才撞一次，避免持续触发封锁。
    this.maxReconnectMs = options.maxReconnectMs || 60000;
    this.methodTimeoutMs = options.methodTimeoutMs || 15000;

    this.ws = null;
    this.connected = false;
    this.loggedInUserId = '';
    this.loginToken = '';
    this.pendingMethods = new Map();
    this.subscriptions = new Set();
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.heartbeatTimer = null;
  }

  get websocketUrl() {
    const wsUrl = this.baseUrl.replace(/^http/i, 'ws');
    return `${wsUrl}/websocket`;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    this.rejectPendingMethods(new Error('Realtime client stopped'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  connect() {
    log('info', 'realtime_connecting', { url: this.websocketUrl });
    this.rejectPendingMethods(new Error('Realtime reconnecting'));
    this.connected = false;
    this.loggedInUserId = '';
    this.subscriptions.clear();

    const ws = new WebSocket(this.websocketUrl);
    this.ws = ws;

    ws.on('open', () => {
      // DDP 握手：宣告支持的协议版本。
      this.send({ msg: 'connect', version: '1', support: ['1'] });
    });

    ws.on('message', (data) => {
      this.handleRawMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      log('warn', 'realtime_closed', { code, reason: reason?.toString() });
      this.clearHeartbeat();
      this.rejectPendingMethods(new Error(`Realtime connection closed: ${code}`));
      this.connected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      if (this.ws !== ws) return;
      log('error', 'realtime_socket_error', errorToMeta(error));
      // 'close' 会随后触发，由它统一处理重连。
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(this.maxReconnectMs, 1000 * 2 ** Math.min(this.reconnectAttempts, 6));
    log('info', 'realtime_reconnect_scheduled', { attempt: this.reconnectAttempts, delayMs: delay });
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  handleRawMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    switch (payload.msg) {
      case 'connected':
        this.onConnected(payload);
        break;
      case 'ping':
        this.send({ msg: 'pong', id: payload.id });
        break;
      case 'pong':
        break;
      case 'result':
        this.onMethodResult(payload);
        break;
      case 'changed':
        this.onChanged(payload);
        break;
      case 'ready':
        break;
      case 'nosub':
        log('warn', 'realtime_subscription_failed', { id: payload.id, error: payload.error });
        break;
      case 'added':
      case 'removed':
      case 'updated':
        break;
      case 'error':
        log('warn', 'realtime_ddp_error', { error: payload.error });
        break;
      default:
        break;
    }
  }

  async onConnected(payload) {
    this.connected = true;
    this.startHeartbeat();
    log('info', 'realtime_connected', { session: payload.session });

    try {
      const result = await this.login();
      this.loggedInUserId = result?.id || this.userId;
      // DDP login 成功会返回 { id, token, tokenExpires }。
      // 这个 token 可用作 REST 的 X-Auth-Token，没有单独配置 PAT 时拿它来发回复。
      this.loginToken = result?.token || '';
      // 只有登录成功才算真正恢复，这时才清零退避计数。
      // 否则登录一直失败时，退避会被反复归零、永远卡在最小间隔，
      // 反而把 Rocket.Chat 的登录限流（error-login-blocked-for-ip）一直续期。
      this.reconnectAttempts = 0;
      log('info', 'realtime_logged_in', { userId: this.loggedInUserId });

      await this.subscribeNotifications();
      this.emit('ready', { userId: this.loggedInUserId, authToken: this.loginToken });
    } catch (error) {
      log('error', 'realtime_login_failed', errorToMeta(error));
      // 登录失败走带退避的重连：保留 reconnectAttempts，让间隔逐步拉长。
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
    }
  }

  login() {
    // 优先使用 username + sha256(password) 登录。
    if (this.username && this.password) {
      const digest = crypto.createHash('sha256').update(this.password).digest('hex');
      return this.callMethod('login', [
        {
          user: { username: this.username },
          password: { digest, algorithm: 'sha-256' }
        }
      ]);
    }
    // 其次：用 resume token 走 resume 登录。
    // resume token 可以是 Personal Access Token (PAT)，也可以是登录接口返回的 authToken——
    // Rocket.Chat 的 DDP login resume 校验的是 services.resume.loginTokens.hashedToken，
    // PAT 和普通 login token 都存在这个数组里，因此 PAT 可直接用于 resume（与 openclaw 等
    // 成熟实现一致）。这样纯 PAT（userId + PAT）即可完成 DDP 登录，无需 bot 密码。
    if (this.resumeToken) {
      return this.callMethod('login', [{ resume: this.resumeToken }]);
    }
    return Promise.reject(new Error('Realtime login requires ROCKET_BOT_USERNAME + ROCKET_BOT_PASSWORD, or a resume token (PAT or login authToken) in resumeToken'));
  }

  async subscribeNotifications() {
    const uid = this.loggedInUserId;
    if (!uid) throw new Error('Cannot subscribe before login resolves a user id');

    // 订阅 stream-room-messages 的 __my_messages__ 通配流：Rocket.Chat 会把 bot 有权访问的
    // 所有房间（私信 DM + 频道）的新消息推过来，只校验 canAccessRoom，不依赖 statusConnection
    // 和用户通知偏好。这解决了部分版本（如 6.2.x）DM 不触发 stream-notify-user/notification
    // 的问题（presence 异步更新导致 statusConnection 仍为 offline，notification 被跳过）。
    this.subscribe('stream-room-messages', ['__my_messages__', { useCollection: false, args: [] }]);
  }

  subscribe(name, params) {
    const id = crypto.randomUUID();
    this.subscriptions.add(id);
    this.send({ msg: 'sub', id, name, params });
    log('info', 'realtime_subscribed', { name, params });
    return id;
  }

  callMethod(method, params = []) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMethods.delete(id);
        reject(new Error(`DDP method timed out: ${method}`));
      }, this.methodTimeoutMs);

      this.pendingMethods.set(id, { resolve, reject, timer });
      this.send({ msg: 'method', method, params, id });
    });
  }

  onMethodResult(payload) {
    const pending = this.pendingMethods.get(payload.id);
    if (!pending) return;
    this.pendingMethods.delete(payload.id);
    clearTimeout(pending.timer);
    if (payload.error) {
      pending.reject(new Error(payload.error.message || payload.error.reason || 'DDP method error'));
    } else {
      pending.resolve(payload.result);
    }
  }

  rejectPendingMethods(error) {
    for (const pending of this.pendingMethods.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingMethods.clear();
  }

  onChanged(payload) {
    if (payload.collection !== 'stream-room-messages') return;
    const args = payload.fields?.args;
    if (!Array.isArray(args) || args.length === 0) return;

    // stream-room-messages 的 changed 事件 payload 形如 { fields: { args: [message] } }。
    const event = parseRoomMessage(args[0]);
    if (event) {
      this.emit('message', event);
    }
  }

  startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ msg: 'ping' });
      }
    }, this.heartbeatMs);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}

/**
 * 把 Rocket.Chat 的 notification payload 规整成统一的消息事件。
 * notification 结构（不同版本字段略有差异）：
 *   {
 *     title, text, payload: { _id, rid, sender: { _id, username, name }, type, message: { msg } }
 *   }
 */
export function parseNotification(notification) {
  if (!notification || typeof notification !== 'object') return null;
  const payload = notification.payload || {};
  const sender = payload.sender || {};

  const roomId = payload.rid || '';
  const messageId = payload._id || payload.message?._id || '';
  const text = payload.message?.msg || notification.text || '';
  const senderId = sender._id || '';
  const senderUsername = sender.username || '';
  // roomType: 'd' 表示私信(direct message)，'c'/'p' 表示频道。
  const roomType = payload.type || '';
  const messageType = payload.message?.t || payload.t || notification.t || '';
  const isDirect = roomType === 'd';
  const rawText = String(text || '').trim();

  if (!roomId || !rawText) return null;

  return {
    roomId,
    messageId,
    text: rawText,
    rawText: String(text),
    senderId,
    userName: senderUsername,
    roomType,
    messageType,
    isDirect,
    isSystem: isSystemMessageType(messageType),
    isAutoReply: isAutoReplyText(rawText)
  };
}

/**
 * 把 stream-room-messages 的 message payload 规整成统一的消息事件。
 * message 结构形如：
 *   { _id, rid, msg, ts: { $date }, u: { _id, username, name }, tmid, t }
 *
 * 注意：stream-room-messages 的消息体里【不含房间类型 room.t】，因此这里无法判断
 * 是私信还是频道，roomType 留空、isDirect 留 undefined，由上层（bot-runner）用
 * REST rooms.info 查询并缓存后补齐。
 */
export function parseRoomMessage(message) {
  if (!message || typeof message !== 'object') return null;

  const sender = message.u || {};
  const roomId = message.rid || '';
  const messageId = message._id || '';
  const text = message.msg || '';
  const senderId = sender._id || '';
  const senderUsername = sender.username || sender.name || '';
  const messageType = message.t || '';
  const rawText = String(text || '').trim();
  // ts 可能是 { $date: <ms> } 或 ISO 字符串；统一转成毫秒时间戳供上层做时间过滤。
  let ts = 0;
  if (message.ts && typeof message.ts === 'object' && typeof message.ts.$date === 'number') {
    ts = message.ts.$date;
  } else if (message.ts) {
    const parsed = Date.parse(message.ts);
    ts = Number.isFinite(parsed) ? parsed : 0;
  }

  if (!roomId || !rawText) return null;

  return {
    roomId,
    messageId,
    text: rawText,
    rawText: String(text),
    senderId,
    userName: senderUsername,
    // roomType / isDirect 由上层用 rooms.info 补齐。
    roomType: '',
    messageType,
    ts,
    isDirect: undefined,
    isSystem: isSystemMessageType(messageType),
    isAutoReply: isAutoReplyText(rawText)
  };
}
