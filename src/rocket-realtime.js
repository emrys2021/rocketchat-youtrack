import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { log, errorToMeta } from './logger.js';

/**
 * Rocket.Chat Realtime (DDP over WebSocket) client.
 *
 * 负责：
 *   1. 连接 ws(s)://<host>/websocket，完成 DDP connect 握手；
 *   2. 用 resume token 或 username/password 完成 DDP login；
 *   3. 订阅 bot 用户的 stream-notify-user 通知（覆盖私信 DM 和 @ 提及）；
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
    this.authToken = options.authToken || '';
    this.username = options.username || '';
    this.password = options.password || '';
    this.heartbeatMs = options.heartbeatMs || 25000;
    // 退避上限给到 60 秒：遇到 error-login-blocked-for-ip 这类登录限流时，
    // 最长 60 秒才撞一次，避免持续触发封锁。
    this.maxReconnectMs = options.maxReconnectMs || 60000;

    this.ws = null;
    this.connected = false;
    this.loggedInUserId = '';
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
      log('warn', 'realtime_closed', { code, reason: reason?.toString() });
      this.clearHeartbeat();
      this.connected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
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
      case 'nosub':
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
      // 只有登录成功才算真正恢复，这时才清零退避计数。
      // 否则登录一直失败时，退避会被反复归零、永远卡在最小间隔，
      // 反而把 Rocket.Chat 的登录限流（error-login-blocked-for-ip）一直续期。
      this.reconnectAttempts = 0;
      log('info', 'realtime_logged_in', { userId: this.loggedInUserId });

      await this.subscribeNotifications();
      this.emit('ready', { userId: this.loggedInUserId });
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
    // PAT 只用于 REST 回复（X-Auth-Token），不要塞进 ROCKET_AUTH_TOKEN 当 resume 用。
    if (this.username && this.password) {
      const digest = crypto.createHash('sha256').update(this.password).digest('hex');
      return this.callMethod('login', [
        {
          user: { username: this.username },
          password: { digest, algorithm: 'sha-256' }
        }
      ]);
    }
    // 兜底：仅当未提供密码时，才把 ROCKET_AUTH_TOKEN 当作 login token 走 resume。
    if (this.authToken) {
      return this.callMethod('login', [{ resume: this.authToken }]);
    }
    return Promise.reject(new Error('Realtime login requires ROCKET_BOT_USERNAME + ROCKET_BOT_PASSWORD (recommended), or a Meteor login token in ROCKET_AUTH_TOKEN'));
  }

  async subscribeNotifications() {
    const uid = this.loggedInUserId;
    if (!uid) throw new Error('Cannot subscribe before login resolves a user id');

    // stream-notify-user 的 notification 事件覆盖私信(DM)和频道 @ 提及，
    // Rocket.Chat 会把需要提醒该用户的新消息推到这里。
    this.subscribe('stream-notify-user', [`${uid}/notification`, false]);
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
      this.pendingMethods.set(id, { resolve, reject });
      this.send({ msg: 'method', method, params, id });
    });
  }

  onMethodResult(payload) {
    const pending = this.pendingMethods.get(payload.id);
    if (!pending) return;
    this.pendingMethods.delete(payload.id);
    if (payload.error) {
      pending.reject(new Error(payload.error.message || payload.error.reason || 'DDP method error'));
    } else {
      pending.resolve(payload.result);
    }
  }

  onChanged(payload) {
    if (payload.collection !== 'stream-notify-user') return;
    const args = payload.fields?.args;
    if (!Array.isArray(args) || args.length === 0) return;

    // notification 事件的 payload 形如 { args: [ notification ] }。
    const notification = args[0];
    const event = parseNotification(notification);
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
  // type: 'd' 表示私信(direct message)，'c'/'p' 表示频道。
  const isDirect = payload.type === 'd';

  if (!roomId || !text) return null;

  return {
    roomId,
    messageId,
    text: String(text).trim(),
    rawText: String(text),
    senderId,
    userName: senderUsername,
    isDirect
  };
}
