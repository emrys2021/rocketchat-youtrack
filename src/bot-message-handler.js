import { errorToMeta } from './logger.js';
import { buildQuestionLogFields } from './question-logging.js';

export function createBotMessageHandler({
  agent,
  rocketClient,
  messageAdmission,
  identityManager,
  rocketConfig,
  loggingConfig = {},
  getActiveMessageStreamMode,
  resolveRoomType,
  onRoomTypeLookupFailed,
  log
}) {
  async function handleIncoming(event) {
    const admission = await messageAdmission.evaluateRealtimeMessage(event, {
      identity: identityManager.getIdentity(),
      mentionName: identityManager.getMentionName(),
      resolveRoomType,
      onRoomTypeLookupFailed
    });

    if (!admission.accepted) {
      logRealtimeAdmissionRejection(event, admission, log);
      return;
    }

    const { question } = admission;
    const admittedEvent = admission.event || event;

    log('info', 'bot_question_received', {
      roomId: admittedEvent.roomId,
      messageId: admittedEvent.messageId,
      userName: admittedEvent.userName,
      isDirect: admittedEvent.isDirect,
      source: admittedEvent.source,
      activeMessageStreamMode: getActiveMessageStreamMode(),
      ...buildQuestionLogFields(question, loggingConfig)
    });

    const replyContext = {
      roomId: admittedEvent.roomId,
      threadId: admittedEvent.messageId,
      replyInThread: admittedEvent.isDirect ? false : rocketConfig.replyInThread
    };

    try {
      if (rocketConfig.postProgress) {
        await safePost(rocketClient, replyContext, '收到，正在处理，请稍候…', log);
      }

      const answer = await agent.answer(question, {
        userName: admittedEvent.userName,
        roomId: admittedEvent.roomId
      });
      await rocketClient.postMessage({ ...replyContext, text: answer });
    } catch (error) {
      log('error', 'bot_answer_failed', {
        roomId: admittedEvent.roomId,
        messageId: admittedEvent.messageId,
        ...errorToMeta(error)
      });
      await safePost(rocketClient, replyContext, `处理失败：${error.message || String(error)}`, log);
    }
  }

  return { handleIncoming };
}

export async function safePost(rocketClient, replyContext, text, log) {
  try {
    await rocketClient.postMessage({ ...replyContext, text });
  } catch (error) {
    log('error', 'bot_post_failed', errorToMeta(error));
  }
}

export function logRealtimeAdmissionRejection(event, admission, log) {
  if (admission.category === 'ignore') {
    log('info', 'bot_message_ignored', {
      reason: admission.reason,
      roomId: event.roomId,
      messageId: event.messageId,
      userName: event.userName,
      senderId: event.senderId,
      isDirect: event.isDirect
    });
    return;
  }

  if (admission.category === 'loop_guard') {
    const loopState = admission.loopState || {};
    log('error', 'bot_loop_guard_tripped', {
      roomId: event.roomId,
      messageId: event.messageId,
      userName: event.userName,
      senderId: event.senderId,
      isDirect: event.isDirect,
      count: loopState.count,
      windowMs: loopState.windowMs,
      maxEvents: loopState.maxEvents,
      recommendation: 'Check Rocket.Chat Auto-Reply settings and bot identity configuration.'
    });
  }
}
