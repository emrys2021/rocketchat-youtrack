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
 *   3. 订阅 bot 用户的 stream-notify-user 通知和 rooms-changed 房间更新；
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
    // 注意：DDP login 的 resume 分支只接受 Meteor login token，
    // 不接受 Personal Access Token（PAT）——用 PAT 会报 "User not found [401]"。
    // PAT 只用于 REST 回复（X-Auth-Token），不要塞进 ROCKET_DDP_RESUME_TOKEN。
    if (this.username && this.password) {
      const digest = crypto.createHash('sha256').update(this.password).digest('hex');
      return this.callMethod('login', [
        {
          user: { username: this.username },
          password: { digest, algorithm: 'sha-256' }
        }
      ]);
    }
    // 兜底：仅当未提供密码时，才用显式配置的登录 authToken 走 resume。
    if (this.resumeToken) {
      return this.callMethod('login', [{ resume: this.resumeToken }]);
    }
    return Promise.reject(new Error('Realtime login requires ROCKET_BOT_USERNAME + ROCKET_BOT_PASSWORD (recommended), or a login authToken in ROCKET_DDP_RESUME_TOKEN'));
  }

  async subscribeNotifications() {
    const uid = this.loggedInUserId;
    if (!uid) throw new Error('Cannot subscribe before login resolves a user id');

    // notification 覆盖频道 @ 提及；rooms-changed 作为私信/房间更新的兜底。
    // 不同 Rocket.Chat 环境对 DM notification 的推送策略不同，不能只依赖 notification。
    this.subscribe('stream-notify-user', [`${uid}/notification`, false]);
    this.subscribe('stream-notify-user', [`${uid}/rooms-changed`, false]);
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
    if (payload.collection !== 'stream-notify-user') return;
    const args = payload.fields?.args;
    if (!Array.isArray(args) || args.length === 0) return;

    const eventName = payload.fields?.eventName || '';
    const event = eventName.endsWith('/rooms-changed')
      ? parseRoomsChanged(args)
      : parseNotification(args[0]);
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
 * 把 stream-notify-user 的 rooms-changed payload 规整成统一的消息事件。
 * rooms-changed 结构通常形如 { args: ['updated', { _id, t, lastMessage }] }。
 */
export function parseRoomsChanged(args) {
  if (!Array.isArray(args) || args.length < 2) return null;
  const [changeType, room] = args;
  if (!['inserted', 'updated'].includes(changeType)) return null;
  if (!room || typeof room !== 'object') return null;

  const lastMessage = room.lastMessage || {};
  const sender = lastMessage.u || lastMessage.sender || {};
  const roomId = room._id || lastMessage.rid || '';
  const messageId = lastMessage._id || '';
  const text = lastMessage.msg || '';
  const senderId = sender._id || '';
  const senderUsername = sender.username || sender.name || '';
  const roomType = room.t || lastMessage.roomType || '';
  const messageType = lastMessage.t || '';
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
    isDirect: roomType === 'd',
    isSystem: isSystemMessageType(messageType),
    isAutoReply: isAutoReplyText(rawText)
  };
}
