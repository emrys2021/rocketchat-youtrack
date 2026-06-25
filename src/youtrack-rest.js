import { fetchJson } from './http.js';

export class YouTrackRestClient {
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || '');
    this.apiToken = options.apiToken || '';
    this.timeoutMs = options.timeoutMs || 30000;
    this.workItemsLimit = options.workItemsLimit || 20;
  }

  canFetchWorkItems() {
    return Boolean(this.baseUrl && this.apiToken);
  }

  async getIssueWorkItems(issueId) {
    if (!this.canFetchWorkItems()) return [];
    if (!issueId) return [];

    const url = new URL(`/api/issues/${encodeURIComponent(issueId)}/timeTracking/workItems`, this.baseUrl);
    url.searchParams.set('fields', [
      'id',
      'text',
      'textPreview',
      'date',
      'created',
      'updated',
      'duration(minutes,presentation)',
      'type(name)',
      'author(login,name)',
      'creator(login,name)',
      'attributes(name,value(name,presentation,text))'
    ].join(','));
    url.searchParams.set('$top', String(this.workItemsLimit));

    return fetchJson(
      url.toString(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiToken}`
        }
      },
      this.timeoutMs
    );
  }
}

export function formatWorkItems(issueId, workItems) {
  if (!Array.isArray(workItems) || workItems.length === 0) {
    return `Work items for ${issueId}: none returned.`;
  }

  const lines = [`Work items for ${issueId}:`];
  workItems.forEach((item, index) => {
    const text = item.text || item.textPreview || '';
    const duration = item.duration?.presentation || minutesToText(item.duration?.minutes);
    const type = item.type?.name || '';
    const author = item.author?.name || item.author?.login || item.creator?.name || item.creator?.login || '';
    const date = msToDate(item.date || item.created);
    const attrs = formatAttributes(item.attributes);

    lines.push([
      `${index + 1}.`,
      date ? `date=${date}` : '',
      type ? `type=${type}` : '',
      duration ? `duration=${duration}` : '',
      author ? `author=${author}` : '',
      text ? `text=${text}` : 'text=(empty)',
      attrs ? `attributes=${attrs}` : ''
    ].filter(Boolean).join(' '));
  });

  return lines.join('\n');
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return '';
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function minutesToText(minutes) {
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function msToDate(value) {
  if (!Number.isFinite(value)) return '';
  return new Date(value).toISOString().slice(0, 10);
}

function formatAttributes(attributes) {
  if (!Array.isArray(attributes) || attributes.length === 0) return '';
  return attributes
    .map((attribute) => {
      const name = attribute.name || '';
      const value = attribute.value?.presentation || attribute.value?.name || attribute.value?.text || '';
      return name && value ? `${name}:${value}` : '';
    })
    .filter(Boolean)
    .join(', ');
}
