import { config } from './config.js';
import { LlmClient } from './llm.js';
import { McpHttpClient } from './mcp.js';
import { RocketClient } from './rocket.js';
import { YouTrackAgent } from './agent.js';
import { YouTrackRestClient } from './youtrack-rest.js';

/**
 * Build the shared service objects used by both the webhook server (server.js)
 * and the realtime bot runner (bot-runner.js).
 *
 * 把 LLM / MCP / YouTrack REST / Rocket.Chat / Agent 的装配集中在这里，
 * 让 outgoing webhook 模式和 bot-login realtime 模式复用同一套依赖。
 */
export function buildRuntime() {
  const llmClient = new LlmClient(config.llm);
  const mcpClient = new McpHttpClient({
    endpoint: config.mcp.url,
    apiKey: config.mcp.apiKey,
    authHeader: config.mcp.authHeader,
    authScheme: config.mcp.authScheme,
    protocolVersion: config.mcp.protocolVersion,
    timeoutMs: config.mcp.timeoutMs,
    toolsCacheSeconds: config.mcp.toolsCacheSeconds,
    resultMaxChars: config.mcp.resultMaxChars
  });
  const youtrackRestClient = new YouTrackRestClient(config.youtrack);
  const rocketClient = new RocketClient(config.rocket);
  const agent = new YouTrackAgent({ llmClient, mcpClient, youtrackRestClient, config });

  return { llmClient, mcpClient, youtrackRestClient, rocketClient, agent };
}
