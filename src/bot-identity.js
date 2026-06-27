import { errorToMeta } from './logger.js';

export function createBotIdentityManager({ rocketClient, rocketConfig, log }) {
  let realtimeBotUserId = rocketConfig.userId || '';
  let restBotUserId = rocketConfig.userId || '';
  let restBotUsername = rocketConfig.botUsername || '';
  let effectiveMentionName = rocketConfig.botUsername || '';
  let identityConfirmed = false;

  function handleRealtimeReadyCredentials({ userId, authToken }) {
    if (userId) realtimeBotUserId = userId;

    if (!rocketClient.canPost()) {
      rocketClient.setCredentials({ userId, authToken });
      if (rocketClient.canPost()) {
        restBotUserId = userId || restBotUserId;
        log('info', 'bot_runner_using_login_token', { userId });
      }
    }

    const configuredUserIdMismatch = rocketConfig.userId && userId && rocketConfig.userId !== userId;
    if (configuredUserIdMismatch) {
      log('warn', 'bot_login_identity_mismatch', {
        configuredUserId: rocketConfig.userId,
        loginUserId: userId,
        recommendation: 'ROCKET_REST_USER_ID should belong to the same bot account used for DDP login.'
      });
    }

    identityConfirmed = false;
  }

  async function validateRestIdentity(loginUserId = '') {
    if (!rocketClient.canPost()) {
      log('warn', 'bot_rest_identity_no_credentials', {
        note: '无 REST 凭据（PAT 或登录 token），无法确认 bot 身份，也无法回复——不订阅消息流。'
      });
      return false;
    }

    try {
      const me = await rocketClient.getMe();
      const actualUser = me.user && typeof me.user === 'object' ? me.user : me;
      const actualUserId = actualUser._id || actualUser.id || '';
      const actualUsername = actualUser.username || '';

      if (!actualUserId) {
        log('warn', 'bot_rest_identity_incomplete', {
          restUsername: actualUsername,
          note: '/api/v1/me 未返回 userId，身份确认失败。'
        });
        return false;
      }

      const loginUserIdMismatch = loginUserId && loginUserId !== actualUserId;
      if (loginUserIdMismatch) {
        log('error', 'bot_identity_account_mismatch', {
          loginUserId,
          restUserId: actualUserId,
          restUsername: actualUsername,
          note: 'DDP 登录账号与 REST(/api/v1/me) 账号不一致，__my_messages__ 模式下会导致自消息过滤失效、死循环。已拒绝订阅。',
          recommendation: 'Use the SAME Rocket.Chat bot account for DDP login (resume token/PAT) and REST replies. Align ROCKET_REST_USER_ID + ROCKET_REST_PAT with the account used for DDP login.'
        });
        return false;
      }

      restBotUserId = actualUserId;
      if (actualUsername) restBotUsername = actualUsername;
      if (!realtimeBotUserId) realtimeBotUserId = actualUserId;
      if (actualUsername) effectiveMentionName = actualUsername;

      const configuredUsernameMismatch = rocketConfig.botUsername && actualUsername && rocketConfig.botUsername !== actualUsername;

      log(configuredUsernameMismatch ? 'warn' : 'info', 'bot_rest_identity_checked', {
        loginUserId,
        restUserId: actualUserId,
        configuredUsername: rocketConfig.botUsername,
        restUsername: actualUsername,
        effectiveMentionName,
        configuredUsernameMismatch,
        recommendation: configuredUsernameMismatch
          ? 'Channel @mention now uses the real account username from /api/v1/me. Update ROCKET_BOT_USERNAME to match if you rely on it elsewhere.'
          : undefined
      });
      return true;
    } catch (error) {
      log('warn', 'bot_rest_identity_check_failed', {
        ...errorToMeta(error),
        recommendation: 'Check ROCKET_URL, ROCKET_REST_USER_ID, and ROCKET_REST_PAT or ROCKET_REST_LOGIN_AUTH_TOKEN.'
      });
      return false;
    }
  }

  return {
    handleRealtimeReadyCredentials,
    validateRestIdentity,
    markConfirmed() {
      identityConfirmed = true;
    },
    isConfirmed() {
      return identityConfirmed;
    },
    getRealtimeBotUserId() {
      return realtimeBotUserId;
    },
    getMentionName() {
      return effectiveMentionName;
    },
    getIdentity() {
      return {
        realtimeBotUserId,
        restBotUserId,
        configuredBotUsername: rocketConfig.botUsername,
        restBotUsername
      };
    },
    getState() {
      return {
        realtimeBotUserId,
        restBotUserId,
        restBotUsername,
        effectiveMentionName,
        identityConfirmed
      };
    }
  };
}
