import { hasRocketBotCredentials } from './config.js';

export function verifyRocketRequest(req, body, expectedToken) {
  if (!expectedToken) return true;

  const headerToken =
    req.headers['x-rocketchat-livechat-token'] ||
    req.headers['x-rocket-chat-token'] ||
    req.headers['x-rocketchat-token'];

  return body?.token === expectedToken || headerToken === expectedToken;
}

export function extractRocketEvent(body, botUsername = '') {
  const message = extractMessage(body);
  const userName =
    body.user_name ||
    body.username ||
    body.user?.username ||
    message?.username ||
    message?.u?.username ||
    '';

  const text =
    body.text ||
    body.msg ||
    message?.msg ||
    message?.text ||
    '';

  const roomId =
    body.channel_id ||
    body.room_id ||
    body.roomId ||
    body.rid ||
    message?.rid ||
    body.channel?.id ||
    '';

  const roomName =
    body.channel_name ||
    body.room_name ||
    body.channel?.name ||
    '';

  const messageId =
    body.message_id ||
    body.messageId ||
    body._id ||
    message?._id ||
    '';

  const isBot =
    Boolean(body.bot) ||
    Boolean(message?.bot) ||
    (botUsername && userName === botUsername);

  return {
    text: cleanTriggerWord(text, body.trigger_word),
    rawText: text,
    roomId,
    roomName,
    userName,
    messageId,
    isBot
  };
}

export function shouldReplyViaBot() {
  return hasRocketBotCredentials();
}

function extractMessage(body) {
  if (Array.isArray(body?.messages) && body.messages.length > 0) {
    return body.messages[body.messages.length - 1];
  }
  if (body?.message && typeof body.message === 'object') {
    return body.message;
  }
  return undefined;
}

function cleanTriggerWord(text, triggerWord) {
  if (!text || !triggerWord) return String(text || '').trim();
  const escaped = triggerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`^\\s*${escaped}\\s*`, 'i'), '').trim();
}
