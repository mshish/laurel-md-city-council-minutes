import path from 'node:path';
import { parse, stringify } from 'yaml';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertSafeObject(value, label = 'value') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains a forbidden key`);
  }
}

function normalizeDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new Error('date must use YYYY-MM-DD');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('date must be a real calendar date');
  }
  return date;
}

function slugify(title) {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return slug || 'meeting';
}

export function meetingPath({ date, title, video_id }) {
  const safeDate = normalizeDate(date);
  const safeTitle = validateTitle(title);
  if (typeof video_id !== 'string' || !VIDEO_ID_RE.test(video_id)) {
    throw new Error('video_id must be an 11-character YouTube video ID');
  }
  return path.posix.join('src', 'content', 'meetings', `${safeDate}-${slugify(safeTitle)}-${video_id}.md`);
}

function validateTitle(title) {
  if (typeof title !== 'string') throw new Error('title must be a string');
  const normalized = title.trim();
  if (!normalized || normalized.length > 180 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('title must contain 1 to 180 printable characters');
  }
  return normalized;
}

function parseTimestamp(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d{1,3}(?::[0-5]?\d){1,2}$/.test(value)) {
    return value.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  }
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
  if (!units || !units[1] && !units[2] && !units[3]) return null;
  const hours = Number(units[1] ?? 0);
  const minutes = Number(units[2] ?? 0);
  const seconds = Number(units[3] ?? 0);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function validateYoutubeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('markdown links must be valid YouTube URLs');
  }
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase()) || url.port || url.username || url.password) {
    throw new Error('markdown links must use an https YouTube URL');
  }
  const isShort = url.hostname.toLowerCase().endsWith('youtu.be');
  const validPath = isShort
    ? /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)
    : url.pathname === '/watch' || /^\/(?:shorts|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname);
  if (!validPath) throw new Error('markdown links must point to a YouTube video');
  for (const key of ['t', 'start', 'time_continue']) {
    for (const timestamp of url.searchParams.getAll(key)) {
      const seconds = parseTimestamp(timestamp);
      if (seconds === null || !Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error('YouTube timestamp links must use valid timestamps');
      }
    }
  }
  return url.toString();
}

export function validateMeetingYoutubeUrl(value, videoId) {
  const url = new URL(validateYoutubeUrl(value));
  const sourceId = url.hostname.toLowerCase().endsWith('youtu.be')
    ? url.pathname.split('/').filter(Boolean)[0]
    : url.pathname === '/watch'
      ? url.searchParams.get('v')
      : url.pathname.split('/').filter(Boolean)[1];
  if (sourceId !== videoId) throw new Error('meeting links must point to the source video');
  return url.toString();
}

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.validateLink = () => true;

function validateMarkdownBody(source, videoId) {
  const tokens = markdown.parse(source, {});
  for (const token of tokens) {
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (child.type === 'image') throw new Error('images are not allowed in meeting minutes');
        if (child.type === 'link_open') {
          const href = child.attrGet('href');
          child.attrSet('href', validateMeetingYoutubeUrl(href, videoId));
        }
      }
    }
  }
  return source.replace(/\r\n?/g, '\n').trim() + '\n';
}

export function validateMarkdown(source, videoId) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > 45_000) {
    throw new Error('markdown must contain 1 to 45000 UTF-8 bytes');
  }
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!frontmatterMatch) throw new Error('markdown must begin with title, date, and video_id YAML frontmatter');
  const frontmatter = parse(frontmatterMatch[1], { uniqueKeys: true, stringKeys: true });
  assertSafeObject(frontmatter, 'markdown frontmatter');
  const fields = Object.keys(frontmatter).sort();
  if (fields.length !== 3 || fields[0] !== 'date' || fields[1] !== 'title' || fields[2] !== 'video_id') {
    throw new Error('markdown frontmatter must contain exactly title, date, and video_id');
  }
  return validateMarkdownBody(frontmatterMatch[2], videoId);
}

export function validatePayload(value) {
  assertSafeObject(value, 'client_payload');
  const dispatchBodyBytes = Buffer.byteLength(JSON.stringify({ event_type: 'publish-minutes', client_payload: value }), 'utf8');
  if (dispatchBodyBytes > 64 * 1024) throw new Error('repository_dispatch JSON payload must not exceed 64 KiB');
  const expected = ['title', 'date', 'video_id', 'markdown'];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== [...expected].sort()[index])) {
    throw new Error('client_payload must contain exactly title, date, video_id, and markdown');
  }
  const payload = {
    title: validateTitle(value.title),
    date: normalizeDate(value.date),
    video_id: value.video_id,
    markdown: value.markdown,
  };
  if (typeof payload.video_id !== 'string' || !VIDEO_ID_RE.test(payload.video_id)) {
    throw new Error('video_id must be an 11-character YouTube video ID');
  }
  const rawMarkdown = payload.markdown;
  if (typeof rawMarkdown !== 'string') throw new Error('markdown must be a string');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(rawMarkdown);
  if (!match) throw new Error('markdown must begin with title, date, and video_id YAML frontmatter');
  const sourceMetadata = parse(match[1], { uniqueKeys: true, stringKeys: true });
  assertSafeObject(sourceMetadata, 'markdown frontmatter');
  if (Object.keys(sourceMetadata).length !== 3 || sourceMetadata.title !== payload.title ||
      sourceMetadata.date !== payload.date || sourceMetadata.video_id !== payload.video_id) {
    throw new Error('markdown frontmatter must match the dispatch title, date, and video_id');
  }
  payload.markdown = validateMarkdown(rawMarkdown, payload.video_id);
  const file = meetingPath(payload);
  return { ...payload, file };
}

export function serializeMeeting({ title, date, video_id, markdown: body }) {
  const metadata = {
    title,
    date,
    video_id,
    video_url: `https://www.youtube.com/watch?v=${video_id}`,
    disclaimer: 'Unofficial AI-generated summary; check the linked recording for the authoritative source.',
  };
  return `---\n${stringify(metadata)}---\n\n${body}`;
}

export function parseMeeting(source, filePath) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`Missing frontmatter in ${filePath}`);
  const metadata = parse(match[1], { uniqueKeys: true, stringKeys: true });
  assertSafeObject(metadata, `frontmatter in ${filePath}`);
  const keys = Object.keys(metadata).sort();
  const expected = ['date', 'disclaimer', 'title', 'video_id', 'video_url'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Unexpected frontmatter fields in ${filePath}`);
  }
  const title = validateTitle(metadata.title);
  const date = normalizeDate(metadata.date);
  const video_id = metadata.video_id;
  if (typeof video_id !== 'string' || !VIDEO_ID_RE.test(video_id)) {
    throw new Error(`Invalid video_id in ${filePath}`);
  }
  const markdownBody = validateMarkdownBody(match[2], video_id);
  const payload = { title, date, video_id, markdown: markdownBody };
  if (metadata.video_url !== `https://www.youtube.com/watch?v=${payload.video_id}` ||
      metadata.disclaimer !== 'Unofficial AI-generated summary; check the linked recording for the authoritative source.') {
    throw new Error(`Invalid source metadata in ${filePath}`);
  }
  return {
    ...payload,
    video_url: `https://www.youtube.com/watch?v=${video_id}`,
    file: filePath,
  };
}

const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'ol', 'p', 'pre',
  'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];

export function renderMarkdown(source, videoId, title = '') {
  const body = title
    ? source.replace(/^# [^\r\n]+(?:\r?\n|$)/, (heading) => heading.trim() === `# ${title}` ? '' : heading)
    : source;
  const rendered = markdown.render(body);
  return sanitizeHtml(rendered, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'] },
    allowedSchemes: ['https'],
    transformTags: {
      a: (_tagName, attributes) => {
        const href = validateMeetingYoutubeUrl(attributes.href, videoId);
        return { tagName: 'a', attribs: { href, rel: 'noopener noreferrer', target: '_blank' } };
      },
    },
  });
}
