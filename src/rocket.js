import { fetchJson } from './http.js';
import { splitMessage } from './text.js';

export class RocketClient {
  constructor(options) {
    this.baseUrl = (options.url || '').replace(/\/$/, '');
    this.userId = options.userId;
    this.authToken = options.authToken;
    this.messageMaxChars = options.messageMaxChars || 3500;
    this.timeoutMs = options.timeoutMs || 15000;
    // roomId → 房间类型('c'/'p'/'d'/'l') 缓存；房间类型不变，查一次即可。
    this._roomTypeCache = new Map();
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
   * 房间类型不会变，按 roomId 缓存，避免每条消息都查一次。
   *
   * @param {string} roomId
   * @returns {Promise<string>} 房间类型字母；查询失败返回空字符串。
   */
  async getRoomType(roomId) {
    if (!roomId) return '';
    if (this._roomTypeCache.has(roomId)) {
      return this._roomTypeCache.get(roomId);
    }
    if (!this.canPost()) {
      throw new Error('Rocket.Chat bot credentials are not configured');
    }

    const url = `${this.baseUrl}/api/v1/rooms.info?roomId=${encodeURIComponent(roomId)}`;
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

    const roomType = result?.room?.t || '';
    if (roomType) this._roomTypeCache.set(roomId, roomType);
    return roomType;
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
