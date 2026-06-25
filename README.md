# YouTrack Rocket Agent

This service receives Rocket.Chat messages, asks an OpenAI-compatible LLM to search YouTrack through MCP, enriches candidate issues with read-only YouTrack REST work items, and posts the final answer back to Rocket.Chat as a bot.

## Flow

1. User mentions the bot or triggers an outgoing webhook in Rocket.Chat.
2. Rocket.Chat posts the message to `POST /webhooks/rocket`.
3. The service verifies `ROCKET_WEBHOOK_TOKEN`.
4. The service lists YouTrack MCP tools through `tools/list`.
5. The service exposes only the read-only tools in `MCP_ALLOWED_TOOLS`.
6. The LLM calls `search_issues`, then the backend auto-enriches top candidate issues with `get_issue`, `get_issue_comments`, and read-only REST work items.
7. The LLM writes a final answer in Simplified Chinese, separating evidence from description, comments, and work items.
8. The service posts the answer to Rocket.Chat with `chat.sendMessage`.

## Required Configuration

Use a full OpenAI-compatible Chat Completions URL:

```text
LLM_API_URL=http://10.15.192.34/v1/chat/completions
LLM_API_KEY=<key>
LLM_MODEL=qwen3.6-35b-a3b-01
```

Use a strict read-only MCP allowlist:

```text
MCP_URL=http://youtrack.example.com/mcp
MCP_API_KEY=<youtrack permanent token>
MCP_ALLOWED_TOOLS=search_issues,get_issue,get_issue_comments
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
docker logs --tail=200 youtrack-rocket-webhook | grep -E 'tool_call|work_items_fetch|auto_enrich'
```

## Rocket.Chat Setup

Recommended setup:

- create a bot user, for example `youtrack-bot`
- create a personal access token for that bot
- configure an outgoing webhook trigger word, for example `@youtrack-bot`
- webhook URL: `http://<backend-server>:8088/webhooks/rocket`

The bot user must be in the target channel to post replies.

## Container Deployment

```bash
cp .env.example .env
vim .env
docker compose up -d --build
```

When YouTrack or Rocket.Chat is on another server, use real IP addresses or DNS names in `MCP_URL`, `YOUTRACK_BASE_URL`, and `ROCKET_URL`. Do not use Docker service names unless the containers share a Docker network.

## Operational Notes

- Do not expose write tools such as `log_work`, `create_issue`, `update_issue`, `add_issue_comment`, or `link_issues`.
- Use a low-privilege YouTrack token that can only read the projects you want exposed.
- `ADMIN_TOKEN` protects local test endpoints and is not a YouTrack token.
- If `/debug/work-items` returns 403, the token lacks permission to read time tracking work items.
