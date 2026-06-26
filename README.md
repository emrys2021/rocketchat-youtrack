# YouTrack Rocket Agent

This service receives Rocket.Chat messages, asks an OpenAI-compatible LLM to search YouTrack issues and Knowledge Base articles through MCP, enriches candidate issues with read-only YouTrack REST work items, and posts the final answer back to Rocket.Chat as a bot.

## Two Modes

The same agent logic (`src/agent.js`) can be driven two ways. Pick one, or run both side by side.

| Mode | Entry | How messages arrive | Best for |
| --- | --- | --- | --- |
| Outgoing webhook (default) | `npm start` (`src/server.js`) | Rocket.Chat outgoing webhook hits `POST /webhooks/rocket` | Stable production setup |
| bot-login realtime | `npm run start:bot` (`src/bot-runner.js`) | Bot logs in and subscribes over WebSocket (DDP) | No webhook config; direct messages + mentions |

Both modes share dependency wiring through `src/runtime.js` and reply through the same REST `chat.sendMessage` client (`src/rocket.js`).

## Flow (outgoing webhook mode)

1. User mentions the bot or triggers an outgoing webhook in Rocket.Chat.
2. Rocket.Chat posts the message to `POST /webhooks/rocket`.
3. The service verifies `ROCKET_WEBHOOK_TOKEN`.
4. The service lists YouTrack MCP tools through `tools/list`.
5. The service exposes only the read-only tools in `MCP_ALLOWED_TOOLS`.
6. The LLM calls `search_issues` and `search_articles` when those tools are available. The backend auto-enriches top candidate issues with `get_issue`, `get_issue_comments`, and read-only REST work items; the LLM can inspect matching Knowledge Base articles with `get_article`.
7. The LLM writes a final answer in Simplified Chinese, separating evidence from issue descriptions, comments, work items, and Knowledge Base articles.
8. The service posts the answer to Rocket.Chat with `chat.sendMessage`.

## Flow (bot-login realtime mode)

1. The bot opens a WebSocket to `ws(s)://<rocket-host>/websocket` and completes the DDP `connect` handshake (`src/rocket-realtime.js`).
2. It logs in over DDP with `ROCKET_BOT_USERNAME` + `ROCKET_BOT_PASSWORD`, or with a resume token via `login({ resume })`. The resume token can be a Personal Access Token (PAT) — Rocket.Chat stores PATs and regular login tokens in the same `services.resume.loginTokens` array, so a PAT works directly for DDP resume. This means a bot can run with only `ROCKET_REST_USER_ID` + `ROCKET_REST_PAT` and no password.
3. **Before subscribing**, it confirms the bot's own identity via `GET /api/v1/me` and records the real `userId`/`username`. It only subscribes after this succeeds; if `/me` fails it retries with backoff and processes **no** messages in the meantime. This is a safety gate: `__my_messages__` echoes the bot's own replies back to it, so the bot must know its own identity to filter them out — otherwise a bot↔bot DM loop can form (see Direct-message safety below).
4. After identity is confirmed, `ROCKET_MESSAGE_STREAM_MODE=auto` first subscribes to `stream-notify-user/notification` plus `rooms-changed`. `notification` is the narrow primary channel; `rooms-changed` is only a probe. If a responsive `lastMessage` appears in `rooms-changed` but the same message is not processed through `notification` within `ROCKET_NOTIFICATION_FALLBACK_MS`, the bot switches to `stream-room-messages/__my_messages__` and processes that missed message through the normal filters.
5. `src/bot-runner.js` filters out the bot's own messages (by real `userId` and username), Rocket.Chat Auto-Reply/system messages, duplicate deliveries, and loop-like repeated room events; it requires an `@youtrack-bot` mention in channels (direct messages need none), strips the mention, and calls `agent.answer()`.
6. The answer is posted back to the original room/thread with the REST client, using `ROCKET_REST_USER_ID` plus either `ROCKET_REST_PAT` (recommended) or `ROCKET_REST_LOGIN_AUTH_TOKEN`.
7. On disconnect it reconnects automatically with exponential backoff, then re-logs in, re-confirms identity, and re-subscribes.

## Required Configuration

Use a full OpenAI-compatible Chat Completions URL:

```text
LLM_API_URL=http://10.15.192.34/v1/chat/completions
LLM_API_KEY=<key>
LLM_MODEL=qwen3.6-35b-a3b-01
```

Use a strict read-only MCP allowlist for issues and Knowledge Base articles:

```text
MCP_URL=http://youtrack.example.com/mcp
MCP_API_KEY=<youtrack permanent token>
MCP_ALLOWED_TOOLS=search_issues,get_issue,get_issue_comments,search_articles,get_article
```

Configure YouTrack REST for work items:

```text
YOUTRACK_BASE_URL=http://youtrack.example.com
YOUTRACK_API_TOKEN=<youtrack permanent token>
YOUTRACK_WORK_ITEMS_LIMIT=20
YOUTRACK_ENRICH_ISSUE_LIMIT=3
YOUTRACK_COMMENTS_LIMIT=20
```

`YOUTRACK_API_TOKEN` can be the same permanent token as `MCP_API_KEY`, as long as it has read permission for issues and time tracking work items.

## Manual Tests Without Rocket.Chat

Health check:

```bash
curl http://localhost:8088/healthz
```

Inspect MCP tools:

```bash
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8088/debug/tools | jq '.tools[] | {name, allowed}'
```

Confirm work items can be read for a known issue:

```bash
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" "http://localhost:8088/debug/work-items?issue=ISSUE-123" | jq
```

Ask a question:

```bash
curl -s -X POST http://localhost:8088/ask \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"question":"outlook打不开超链接，有没有类似问题反馈？"}'
```

Review logs:

```bash
docker logs --tail=200 youtrack-rocket-bot | grep -E 'tool_call|work_items_fetch|auto_enrich'
```

## Rocket.Chat Setup

Recommended setup for **outgoing webhook mode**:

- create a bot user, for example `youtrack-bot`
- create a personal access token for that bot
- configure an outgoing webhook trigger word, for example `@youtrack-bot`
- webhook URL: `http://<backend-server>:8088/webhooks/rocket`

The bot user must be in the target channel to post replies.

For **bot-login realtime mode** no webhook is needed. Instead:

- create the same bot user, for example `youtrack-bot`
- set `ROCKET_BOT_USERNAME` + `ROCKET_BOT_PASSWORD` for the WebSocket (DDP) login. A PAT cannot be used as a username/password login, but it **can** be used as the token in `login({ resume })` — so a PAT is a valid DDP credential via resume (see PAT-only mode below). `ROCKET_DDP_RESUME_TOKEN` accepts either a login authToken or a PAT.
- PAT-only mode (production policies that forbid bot passwords): set only `ROCKET_REST_USER_ID` + `ROCKET_REST_PAT` (no password, no resume token). The PAT is used directly as the DDP resume token for login and as the `X-Auth-Token` for REST replies. No server-side environment variable is required.
- recommended: create a Personal Access Token for that bot and set `ROCKET_REST_USER_ID` + `ROCKET_REST_PAT` so REST replies use a stable bot token. If you do not want PAT, set `ROCKET_REST_USER_ID` + `ROCKET_REST_LOGIN_AUTH_TOKEN` using the login API authToken. If neither REST token is set, the service falls back to the DDP login token after startup.
- set `ROCKET_URL` to the Rocket.Chat base URL (the WebSocket URL is derived as `<url>/websocket`)
- leave `ROCKET_MESSAGE_STREAM_MODE=auto` for the default behavior: notification first, `rooms-changed` probe, then fallback to `__my_messages__` if a responsive message is missed. Use `notification` only when you want the narrow channel without fallback, or `my_messages` when a Rocket.Chat version/environment does not emit notification/rooms-changed reliably for DMs.
- invite the bot to any channel where it should answer; users mention it with `@<bot-username>`, or message it directly. The channel @mention name is the bot account's real username (resolved from `/api/v1/me` at startup), not necessarily `ROCKET_BOT_USERNAME` — so in PAT-only mode you can mention the real account even if `ROCKET_BOT_USERNAME` is left at its default. Direct messages need no mention.

Start it with `npm run start:bot`.

Direct-message safety:

- keep `ROCKET_IGNORE_AUTO_REPLIES=true` so Rocket.Chat user Auto-Reply messages are ignored
- keep `ROCKET_BOT_USERNAME` and `ROCKET_REST_USER_ID` aligned with the same bot account; bot-login logs `bot_rest_identity_checked` at startup and warns on mismatch
- **identity gate (bot↔bot loop protection):** because `__my_messages__` echoes the bot's own replies, bot-login does **not** subscribe until `GET /api/v1/me` confirms the bot's real `userId`. If `/me` keeps failing you'll see repeated `bot_identity_unconfirmed_retry` and the bot will stay idle (no subscription, no replies) by design — fix `ROCKET_URL`/`ROCKET_REST_USER_ID`/`ROCKET_REST_PAT` so identity can be confirmed. Successful subscription logs `bot_runner_subscribed_after_identity`.
- **account-match requirement (hard fail):** the DDP login account and the REST (`/me`) account **must be the same** Rocket.Chat user. If they differ, self-message filtering breaks under `__my_messages__` and a loop can form, so bot-login refuses to subscribe and logs `bot_identity_account_mismatch` (error) and keeps retrying. Align `ROCKET_REST_USER_ID` + `ROCKET_REST_PAT` with the account used for DDP login.
- if `bot_loop_guard_tripped` or `rocket_loop_guard_tripped` appears in logs, check whether a user Auto-Reply is responding to bot messages and whether REST replies are posted by the expected bot account
- `ROCKET_LOOP_WINDOW_MS` and `ROCKET_LOOP_MAX_EVENTS` control the per-room loop guard; defaults are `60000` and `4`
- `ROCKET_MESSAGE_DEDUPE_TTL_MS` ignores repeated delivery of the same Rocket.Chat `message_id`; default is `600000`
- `ROCKET_NOTIFICATION_FALLBACK_MS` controls how long auto mode waits for notification after `rooms-changed` reports a responsive `lastMessage`; default is `2000`

## Container Deployment

This branch (`bot-login`) ships the realtime bot. The `outgoing-webhook` branch ships the webhook server; each branch has its own `compose.yaml`.

```bash
cp .env.example .env
vim .env
docker compose up -d --build
```

`compose.yaml` here runs `node src/bot-runner.js`. The bot dials out over WebSocket, so it exposes no port.

When YouTrack or Rocket.Chat is on another server, use real IP addresses or DNS names in `MCP_URL`, `YOUTRACK_BASE_URL`, and `ROCKET_URL`. Do not use Docker service names unless the containers share a Docker network.

## Operational Notes

- Do not expose write tools such as `log_work`, `create_issue`, `update_issue`, `add_issue_comment`, `link_issues`, `create_article`, or `update_article`.
- Use a low-privilege YouTrack token that can only read the projects you want exposed.
- `ADMIN_TOKEN` protects local test endpoints and is not a YouTrack token.
- If `/debug/work-items` returns 403, the token lacks permission to read time tracking work items.
- In `auto` mode, bot-login starts with `notification + rooms-changed`; if the fallback triggers, logs show `bot_realtime_fallback_to_room_messages`, and future messages also arrive through `__my_messages__`.
- bot-login looks up room type via `rooms.info` only for non-mention messages (mentions are handled regardless of type, so no lookup is needed). Results are cached: successful types permanently, failures with a short negative-cache TTL. This prevents a "failing room + high-traffic channel" combo from re-querying `rooms.info` on every message. Repeated `bot_room_type_lookup_failed` for the same room means the bot lacks read access to that room — the negative cache caps the request rate to once per TTL.
