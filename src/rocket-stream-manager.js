import { log as defaultLog } from './logger.js';

export function createRocketStreamManager({
  realtime,
  mode = 'auto',
  notificationFallbackMs = 2000,
  messageDeduper,
  evaluateProbe,
  handleFallbackMessage,
  log = defaultLog
}) {
  let activeMessageStreamMode = '';
  const notificationFallbackTimers = new Map();

  return {
    subscribe(userId) {
      if (mode === 'my_messages') {
        if (realtime.subscribeToMessages()) activeMessageStreamMode = 'my_messages';
        return activeMessageStreamMode;
      }

      if (mode === 'notification') {
        if (realtime.subscribeToNotifications(userId)) activeMessageStreamMode = 'notification';
        return activeMessageStreamMode;
      }

      if (realtime.subscribeToNotificationProbe(userId)) {
        activeMessageStreamMode = 'notification_probe';
      }
      return activeMessageStreamMode;
    },

    async handleRoomChanged(event) {
      if (mode !== 'auto') return;
      if (activeMessageStreamMode === 'my_messages') return;
      if (typeof evaluateProbe !== 'function') return;

      const probeEvent = { ...event };
      const admission = await evaluateProbe(probeEvent);
      if (!admission.accepted) return;

      const key = admission.messageKey;
      if (!key || notificationFallbackTimers.has(key) || messageDeduper?.has(key)) return;

      const timer = setTimeout(() => {
        notificationFallbackTimers.delete(key);
        if (messageDeduper?.has(key)) return;

        activateRoomMessagesFallback('notification_missed_after_rooms_changed', event);
        if (typeof handleFallbackMessage === 'function') {
          const { isDirect: _probeIsDirect, roomType: _probeRoomType, ...cleanEvent } = event;
          void handleFallbackMessage({ ...cleanEvent, source: 'rooms_changed_fallback' });
        }
      }, notificationFallbackMs);
      notificationFallbackTimers.set(key, timer);

      log('info', 'bot_notification_fallback_scheduled', {
        roomId: event.roomId,
        messageId: event.messageId,
        userName: event.userName,
        isDirect: admission.event?.isDirect ?? probeEvent.isDirect ?? event.isDirect,
        delayMs: notificationFallbackMs
      });
    },

    activateFallback: activateRoomMessagesFallback,

    getActiveMode() {
      return activeMessageStreamMode;
    },

    reset() {
      activeMessageStreamMode = '';
      clearTimers();
    }
  };

  function activateRoomMessagesFallback(reason, event = {}) {
    if (activeMessageStreamMode === 'my_messages') return false;
    const subscribed = realtime.subscribeToMessages();
    if (!subscribed) return false;
    activeMessageStreamMode = 'my_messages';
    log('warn', 'bot_realtime_fallback_to_room_messages', {
      reason,
      roomId: event.roomId,
      messageId: event.messageId,
      userName: event.userName,
      note: 'notification 未在 fallback 窗口内送达，已切换到 __my_messages__ 可靠消息流。'
    });
    return true;
  }

  function clearTimers() {
    for (const timer of notificationFallbackTimers.values()) {
      clearTimeout(timer);
    }
    notificationFallbackTimers.clear();
  }
}
