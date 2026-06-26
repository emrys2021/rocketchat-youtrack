import { fetchJson } from './http.js';
import { splitMessage } from './text.js';

export class RocketClient {
  constructor(options) {
    this.baseUrl = (options.url || '').replace(/\/$/, '');
    this.userId = options.userId;
    this.authToken = options.authToken;
    this.messageMaxChars = options.messageMaxChars || 3500;
    this.timeoutMs = options.timeoutMs || 15000;
    // roomId → { type, expires } 缓存。
    //   - 成功：type 为房间类型('c'/'p'/'d'/'l')，expires=0 表示永不过期（房间类型不变）。
    //   - 失败：type 为 ''，带短 TTL 的负缓存，避免“失败房间 + 大流量”下每条消息都重查 rooms.info。
    // 加上限防止房间数无限增长导致内存泄漏（尤其私信房间会随用户数增长）。
    this._roomTypeCache = new Map();
    this._roomTypeCacheMax = options.roomTypeCacheMax || 5000;
    this._roomTypeNegativeTtlMs = options.roomTypeNegativeTtlMs || 60000;
  }

  canPost() {
    return Boolean(this.baseUrl && this.userId && this.authToken);
  }

  // 运行时回填回复凭据。bot-login 模式下若未配置 PAT，
  // 用 realtime 登录返回的 userId/token 兜底，使 bot 仍能发回复。
  setCredentials({ userId, authToken }) {
    if (userId) this.userId = userId;
    if (authToken) this.authToken = authToken;
  }

  async getMe() {
    if (!this.canPost()) {
      throw new Error('Rocket.Chat bot credentials are not configured');
    }

    return fetchJson(
      `${this.baseUrl}/api/v1/me`,
      {
        method: 'GET',
        headers: {
          'X-Auth-Token': this.authToken,
          'X-User-Id': this.userId
        }
      },
      this.timeoutMs
    );
  }

  /**
   * 查询房间类型（'c' 频道 / 'p' 私有组 / 'd' 私信 / 'l' livechat）。
   *
   * stream-room-messages 推送的消息体不含房间类型，需要用 REST rooms.info 补齐。
   * 成功结果永久缓存（房间类型不变）；失败/空结果按短 TTL 负缓存，避免“失败房间 +
   * 大流量”下每条消息都重打 rooms.info（REST 请求放大）。
   *
   * @param {string} roomId
   * @returns {Promise<string>} 房间类型字母；查询失败或未知返回空字符串。
   */
  async getRoomType(roomId) {
    if (!roomId) return '';

    const cached = this._roomTypeCache.get(roomId);
    if (cached && (cached.expires === 0 || cached.expires > Date.now())) {
      return cached.type;
    }

    if (!this.canPost()) {
      throw new Error('Rocket.Chat bot credentials are not configured');
    }

    const url = `${this.baseUrl}/api/v1/rooms.info?roomId=${encodeURIComponent(roomId)}`;
    let roomType = '';
    try {
      const result = await fetchJson(
        url,
        {
          method: 'GET',
          headers: {
            'X-Auth-Token': this.authToken,
            'X-User-Id': this.userId
          }
        },
        this.timeoutMs
      );
      roomType = result?.room?.t || '';
    } catch (error) {
      // 查询失败：写负缓存抑制重查，再把错误抛给上层记录/降级。
      this._setRoomTypeCache(roomId, '', this._roomTypeNegativeTtlMs);
      throw error;
    }

    // 成功且拿到类型 → 永久缓存；成功但类型为空（异常响应）→ 负缓存短期抑制。
    this._setRoomTypeCache(roomId, roomType, roomType ? 0 : this._roomTypeNegativeTtlMs);
    return roomType;
  }

  /**
   * 写入房间类型缓存，并在超过上限时淘汰最早写入的一条（FIFO），防止内存无限增长。
   * @param {string} roomId
   * @param {string} type 房间类型；空串表示负缓存。
   * @param {number} ttlMs 0 表示永不过期。
   */
  _setRoomTypeCache(roomId, type, ttlMs) {
    // 先删后加，确保更新的条目排到 Map 末尾，淘汰时优先删最早的。
    this._roomTypeCache.delete(roomId);
    this._roomTypeCache.set(roomId, { type, expires: ttlMs ? Date.now() + ttlMs : 0 });
    if (this._roomTypeCache.size > this._roomTypeCacheMax) {
      const oldest = this._roomTypeCache.keys().next().value;
      if (oldest !== undefined) this._roomTypeCache.delete(oldest);
    }
  }

  async postMessage({ roomId, text, threadId = undefined, replyInThread = true }) {
    if (!this.canPost()) {
      throw new Error('Rocket.Chat bot credentials are not configured');
    }
    if (!roomId) {
      throw new Error('Cannot post Rocket.Chat message without roomId');
    }

    const chunks = splitMessage(text, this.messageMaxChars);
    for (const chunk of chunks) {
      const message = {
        rid: roomId,
        msg: chunk
      };

      if (replyInThread && threadId) {
        message.tmid = threadId;
        message.tshow = true;
      }

      await fetchJson(
        `${this.baseUrl}/api/v1/chat.sendMessage`,
        {
          method: 'POST',
          headers: {
            'X-Auth-Token': this.authToken,
            'X-User-Id': this.userId,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            message,
            previewUrls: []
          })
        },
        this.timeoutMs
      );
    }
  }
}
