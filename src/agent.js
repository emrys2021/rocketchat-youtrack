import { parseToolArguments } from './llm.js';
import { toLlmTools } from './mcp.js';
import { log } from './logger.js';
import { normalizeRocketMarkdown, truncateText } from './text.js';
import { formatWorkItems } from './youtrack-rest.js';

const SYSTEM_PROMPT = [
  'You are a YouTrack issue search assistant for operations and engineering users.',
  'The user may paste an error, stack trace, alert, or symptom and ask whether similar issues exist.',
  'Use only the provided read-only YouTrack MCP tools to search issues, descriptions, comments, issue details, and Knowledge Base articles.',
  'Do not create, update, delete, transition, assign, log work, comment on issues, create articles, or update articles.',
  'For issue summary or issue-detail questions, focus on issue details, comments, and work items; do not search Knowledge Base unless the user asks for a solution, troubleshooting guidance, operation guide, or Knowledge Base information.',
  'For similar issue questions, search related issues first. For solution, troubleshooting, workaround, operation guide, or Knowledge Base questions, also inspect relevant Knowledge Base articles when the tool is available.',
  'The backend may append read-only YouTrack REST work item evidence to search_issues or get_issue results. Treat that as source evidence.',
  'When answering, write in Simplified Chinese.',
  'Explain from the user business scenario: what they are seeing, which issues look related, why, and what to check next.',
  'For solutions, explicitly separate evidence found in issue descriptions, comments, work items, and Knowledge Base articles. If a source does not contain a solution, say that clearly.',
  'Rocket.Chat formatting rules: use short headings and bullet lists; do not use Markdown tables. For issue lists, prefer list items like - [ISSUE-ID](url) | title | status | owner. If aligned columns are truly necessary, use a fenced text code block instead of a Markdown table.',
  'Prefer concise answers. Include issue id, article id, title, status, project, and URL when available.',
  'If results are weak, say so and provide better search keywords.'
].join('\n');

export class YouTrackAgent {
  constructor({ llmClient, mcpClient, youtrackRestClient = null, config }) {
    this.llm = llmClient;
    this.mcp = mcpClient;
    this.youtrackRest = youtrackRestClient;
    this.config = config;
  }

  async answer(question, context = {}) {
    const mcpTools = await this.mcp.listTools();
    const { tools, nameMap } = toLlmTools(
      mcpTools,
      this.config.mcp.allowedTools,
      this.config.mcp.blockedToolWords
    );

    if (tools.length === 0) {
      throw new Error('No MCP tools are available after filtering. Set MCP_ALLOWED_TOOLS or adjust MCP_BLOCKED_TOOL_WORDS.');
    }

    log('info', 'llm_tools_available', {
      tools: tools.map((tool) => tool.function.name),
      user: context.userName,
      roomId: context.roomId
    });

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildUserPrompt(question, context)
      }
    ];
    const calledToolNames = new Set();
    const remindedRetrievalPrompts = new Set();

    for (let round = 0; round < this.config.mcp.maxToolRounds; round += 1) {
      const assistantMessage = await this.llm.chat(messages, tools);
      messages.push(assistantMessage);

      const toolCalls = normalizeToolCalls(assistantMessage);
      if (toolCalls.length === 0) {
        const searchReminder = buildInitialSearchReminder(tools, calledToolNames, remindedRetrievalPrompts);
        if (searchReminder) {
          messages.push({
            role: 'user',
            content: searchReminder
          });
          continue;
        }
        return normalizeRocketMarkdown(assistantMessage.content || '没有生成可用回答。');
      }

      for (const toolCall of toolCalls) {
        const safeName = toolCall.function?.name;
        const mcpName = nameMap.get(safeName);
        const args = parseToolArguments(toolCall.function?.arguments);

        if (!mcpName) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Tool ${safeName} is not allowed.`
          });
          continue;
        }

        calledToolNames.add(mcpName);

        log('info', 'tool_call', {
          tool: mcpName,
          safeTool: safeName,
          user: context.userName,
          roomId: context.roomId
        });

        try {
          const result = await this.mcp.callTool(mcpName, args);
          let content = result.text || (result.isError ? 'Tool returned an error without text.' : 'Tool returned no text.');
          content = await this.enrichToolResult(mcpName, args, content);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content
          });
        } catch (error) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: truncateText(`Tool call failed: ${error.message || String(error)}`, 2000)
          });
        }
      }
    }

    messages.push({
      role: 'user',
      content: 'Tool call limit reached. Summarize the available issue details, comments, work item evidence, and Knowledge Base article evidence. Answer the original question in Simplified Chinese.'
    });

    const finalMessage = await this.llm.chat(messages);
    return normalizeRocketMarkdown(finalMessage.content || '工具调用已达到上限，但没有生成可用回答。');
  }

  async enrichToolResult(toolName, args, content) {
    if (toolName === 'search_issues') {
      return this.enrichSearchIssues(content);
    }

    if (toolName === 'get_issue') {
      const issueId = extractIssueIdFromArgs(args) || extractIssueIds(content)[0];
      if (!issueId) return content;
      const workItemsText = await this.fetchWorkItemsText(issueId);
      if (!workItemsText) return content;
      return truncateText(`${content}\n\nAdditional read-only work item evidence fetched via YouTrack REST:\n${workItemsText}`, this.config.mcp.resultMaxChars);
    }

    return content;
  }

  async enrichSearchIssues(content) {
    const issueIds = extractIssueIds(content).slice(0, this.config.youtrack.enrichIssueLimit);
    if (issueIds.length === 0) return content;

    const sections = [];
    for (const issueId of issueIds) {
      const section = await this.buildIssueEvidence(issueId);
      if (section) sections.push(section);
    }

    if (sections.length === 0) return content;

    return truncateText([
      content,
      '',
      'Additional read-only evidence for top candidate issues:',
      sections.join('\n\n')
    ].join('\n'), this.config.mcp.resultMaxChars);
  }

  async buildIssueEvidence(issueId) {
    const parts = [`Issue ${issueId}:`];

    const detail = await this.safeMcpRead('get_issue', { issueId });
    if (detail) parts.push(`Details:\n${detail}`);

    const comments = await this.safeMcpRead('get_issue_comments', {
      issueId,
      limit: this.config.youtrack.commentsLimit
    });
    if (comments) parts.push(`Comments:\n${comments}`);

    const workItems = await this.fetchWorkItemsText(issueId);
    if (workItems) parts.push(`Work items:\n${workItems}`);

    return parts.length > 1 ? parts.join('\n') : '';
  }

  async safeMcpRead(toolName, args) {
    try {
      log('info', 'tool_call_auto_enrich', { tool: toolName, issueId: args.issueId });
      const result = await this.mcp.callTool(toolName, args);
      return result.text || '';
    } catch (error) {
      log('warn', 'tool_call_auto_enrich_failed', {
        tool: toolName,
        issueId: args.issueId,
        error: error.message || String(error)
      });
      return '';
    }
  }

  async fetchWorkItemsText(issueId) {
    if (!this.youtrackRest?.canFetchWorkItems()) return '';

    try {
      const workItems = await this.youtrackRest.getIssueWorkItems(issueId);
      log('info', 'work_items_fetch', {
        issueId,
        count: Array.isArray(workItems) ? workItems.length : 0
      });
      return formatWorkItems(issueId, workItems);
    } catch (error) {
      log('warn', 'work_items_fetch_failed', {
        issueId,
        error: error.message || String(error)
      });
      return '';
    }
  }
}

function buildUserPrompt(question, context) {
  const metadata = [];
  if (context.userName) metadata.push(`Rocket.Chat user: ${context.userName}`);
  if (context.roomName) metadata.push(`Room: ${context.roomName}`);

  return [
    metadata.length ? metadata.join('\n') : '',
    'User question:',
    question
  ].filter(Boolean).join('\n\n');
}

function normalizeToolCalls(message) {
  if (Array.isArray(message.tool_calls)) return message.tool_calls;

  if (message.function_call) {
    return [{
      id: 'function_call',
      type: 'function',
      function: message.function_call
    }];
  }

  return [];
}

function hasTool(tools, name) {
  return tools.some((tool) => tool.function?.name === name);
}

export function buildInitialSearchReminder(tools, calledToolNames = new Set(), remindedRetrievalPrompts = new Set()) {
  const retrievalToolNames = [
    'search_issues',
    'get_issue',
    'get_issue_comments',
    'search_articles',
    'get_article'
  ];
  const hasRetrievalTool = retrievalToolNames.some((toolName) => hasTool(tools, toolName));
  const alreadyRetrieved = retrievalToolNames.some((toolName) => calledToolNames.has(toolName));

  if (!hasRetrievalTool || alreadyRetrieved || remindedRetrievalPrompts.has('__retrieval_reminder__')) return '';
  remindedRetrievalPrompts.add('__retrieval_reminder__');

  return '你还没有调用任何 YouTrack 只读工具。请先根据用户问题选择合适的可用工具检索事实，再基于工具结果回答。只是总结指定 issue 时，围绕 issue 详情、评论和处理记录；需要解决方案、排障、操作指引或知识库资料时，再检索 Knowledge Base。';
}

function extractIssueIdFromArgs(args) {
  for (const key of ['issueId', 'issueID', 'id', 'issue', 'issueReadableId', 'idReadable']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) {
      return args[key].trim();
    }
  }
  return '';
}

export function extractIssueIds(text) {
  const ids = new Set();
  const source = String(text || '');

  for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]{1,20}-\d+\b/g)) {
    ids.add(match[0]);
  }

  for (const match of source.matchAll(/"idReadable"\s*:\s*"([^"]+)"/g)) {
    ids.add(match[1]);
  }

  for (const match of source.matchAll(/"id"\s*:\s*"(\d+-\d+)"/g)) {
    ids.add(match[1]);
  }

  return [...ids];
}
