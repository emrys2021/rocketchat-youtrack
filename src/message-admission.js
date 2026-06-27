export function createMessageAdmission({ deduper, loopGuard, ignoreAutoReplies = true } = {}) {
  return {
    evaluateWebhookMessage(event) {
      const ignoreReason = getWebhookIgnoreReason(event, ignoreAutoReplies);
      if (ignoreReason) return deny(ignoreReason, 'ignore');

      const dedupeState = deduper?.checkAndRemember(event?.messageId) || { duplicate: false };
      if (dedupeState.duplicate) {
        return deny('duplicate_message', 'dedupe', { dedupeState });
      }

      const loopState = loopGuard?.record(event) || { blocked: false };
      if (loopState.blocked) {
        return deny('loop_guard', 'loop_guard', { loopState });
      }

      return allow({ event, dedupeState, loopState });
    },

    async evaluateRealtimeMessage(event, options = {}) {
      const ignoreReason = getRealtimeIgnoreReason(event, options.identity || {}, ignoreAutoReplies);
      if (ignoreReason) return deny(ignoreReason, 'ignore');

      const messageKey = getMessageKey(event);
      if (deduper?.has(messageKey)) {
        return deny('duplicate_message', 'dedupe', { messageKey, dedupeState: { duplicate: true, key: messageKey } });
      }

      const mention = buildMention(options.mentionName);
      const isMentioned = isEventMentioned(event, mention);
      await ensureRealtimeRoomType(event, isMentioned, options);

      if (!event.isDirect && !isMentioned) {
        return deny('not_addressed', 'addressing', { messageKey, mention, isMentioned });
      }

      const question = stripMention(event.text, mention).trim();
      if (!question) {
        return deny('empty_question', 'addressing', { messageKey, mention, isMentioned });
      }

      const dedupeState = deduper?.checkAndRemember(messageKey) || { duplicate: false, key: messageKey };
      if (dedupeState.duplicate) {
        return deny('duplicate_message', 'dedupe', { messageKey, dedupeState });
      }

      const loopState = loopGuard?.record(event) || { blocked: false };
      if (loopState.blocked) {
        return deny('loop_guard', 'loop_guard', { messageKey, mention, isMentioned, question, loopState });
      }

      return allow({ event, messageKey, mention, isMentioned, question, dedupeState, loopState });
    },

    async evaluateRealtimeProbe(event, options = {}) {
      const ignoreReason = getRealtimeIgnoreReason(event, options.identity || {}, ignoreAutoReplies);
      if (ignoreReason) return deny(ignoreReason, 'ignore');

      const mention = buildMention(options.mentionName);
      const isMentioned = isEventMentioned(event, mention);
      const roomTypeState = await ensureRealtimeRoomType(event, isMentioned, options);

      if (!event.isDirect && !isMentioned && roomTypeState !== 'lookup_failed') {
        return deny('not_addressed', 'addressing', { mention, isMentioned });
      }

      const messageKey = getMessageKey(event);
      if (!messageKey) return deny('missing_message_key', 'dedupe', { mention, isMentioned });

      return allow({ event, messageKey, mention, isMentioned });
    }
  };
}

export function getWebhookIgnoreReason(event, ignoreAutoReplies = true) {
  if (!event?.text) return 'empty_text';
  if (event.isBot) return 'bot_message';
  if (event.isSystem) return 'system_message';
  if (ignoreAutoReplies && event.isAutoReply) return 'auto_reply';
  return '';
}

export function getRealtimeIgnoreReason(event, identity = {}, ignoreAutoReplies = true) {
  if (!event?.text) return 'empty_text';
  if (event.senderId && identity.realtimeBotUserId && event.senderId === identity.realtimeBotUserId) return 'bot_message';
  if (event.senderId && identity.restBotUserId && event.senderId === identity.restBotUserId) return 'bot_message';
  if (identity.configuredBotUsername && event.userName === identity.configuredBotUsername) return 'bot_message';
  if (identity.restBotUsername && event.userName === identity.restBotUsername) return 'bot_message';
  if (event.isSystem) return 'system_message';
  if (ignoreAutoReplies && event.isAutoReply) return 'auto_reply';
  return '';
}

export function buildMention(username) {
  return username ? `@${username}` : '';
}

export function isEventMentioned(event, mention) {
  return Boolean(mention && event?.text?.includes(mention));
}

export function stripMention(text, mention) {
  if (!mention) return String(text || '');
  // Rocket.Chat may include the bot mention more than once. Remove every literal mention
  // so the LLM receives only the user's actual question, not addressing noise.
  return String(text || '').split(mention).join(' ');
}

export function getMessageKey(event) {
  if (event?.messageId) return event.messageId;
  return [event?.roomId, event?.userName, event?.rawText || event?.text].join(':');
}

async function ensureRealtimeRoomType(event, isMentioned, options) {
  if (event.isDirect !== undefined) return 'known';

  if (isMentioned) {
    event.isDirect = false;
    return 'mentioned';
  }

  if (typeof options.resolveRoomType !== 'function') {
    event.isDirect = false;
    return 'missing_resolver';
  }

  try {
    const roomType = await options.resolveRoomType(event);
    event.roomType = roomType || event.roomType || '';
    event.isDirect = roomType === 'd';
    return 'resolved';
  } catch (error) {
    event.isDirect = false;
    if (typeof options.onRoomTypeLookupFailed === 'function') {
      options.onRoomTypeLookupFailed(error, event);
    }
    return 'lookup_failed';
  }
}

function allow(extra = {}) {
  return { accepted: true, reason: '', category: '', ...extra };
}

function deny(reason, category, extra = {}) {
  return { accepted: false, reason, category, ...extra };
}
