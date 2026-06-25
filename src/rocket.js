import { fetchJson } from './http.js';
import { splitMessage } from './text.js';

export class RocketClient {
  constructor(options) {
    this.baseUrl = (options.url || '').replace(/\/$/, '');
    this.userId = options.userId;
    this.authToken = options.authToken;
    this.messageMaxChars = options.messageMaxChars || 3500;
    this.timeoutMs = options.timeoutMs || 15000;
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
