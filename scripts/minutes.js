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

const LEGACY_DISCLAIMER = 'Unofficial AI-generated minutes based on a spoken transcript. Not approved by the City of Laurel. Verify decisions against the source and official city records.';
const CALLOUT_LABELS = new Map([
  ['Look closer:', 'callout-look-closer'],
  ['Resident impact:', 'callout-resident-impact'],
  ['Open question:', 'callout-open-question'],
]);

function visibleInlineText(tokens = []) {
  return tokens.map((token) => {
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline') return token.content;
    if (token.type === 'image') return token.content || token.attrGet('alt') || '';
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return token.children ? visibleInlineText(token.children) : '';
  }).join('');
}

function slugHeading(text) {
  const slug = text.normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function linkTimestamps(tokens, videoId) {
  let insideLink = false;
  for (const token of tokens) {
    if (token.type === 'link_open') insideLink = true;
    if (token.type === 'text' && !insideLink && /\[\d{2}:\d{2}:\d{2}\]/.test(token.content)) {
      const parts = [];
      let lastIndex = 0;
      const marker = /\[(\d{2}):(\d{2}):(\d{2})\]/g;
      for (const match of token.content.matchAll(marker)) {
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);
        if (minutes > 59 || seconds > 59) continue;
        if (match.index > lastIndex) parts.push({ text: token.content.slice(lastIndex, match.index) });
        const total = Number(match[1]) * 3600 + minutes * 60 + seconds;
        parts.push({ text: match[0], href: `https://www.youtube.com/watch?v=${videoId}&t=${total}` });
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex > 0 && lastIndex < token.content.length) parts.push({ text: token.content.slice(lastIndex) });
      if (lastIndex > 0) token.meta = { ...(token.meta ?? {}), timestampParts: parts };
    }
    if (token.type === 'link_close') insideLink = false;
  }
}

function stripLegacyDisclaimer(tokens, title = '') {
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children?.length) continue;
    const text = visibleInlineText(token.children);
    if (!text.includes(LEGACY_DISCLAIMER)) continue;
    const legacyStart = title ? `${title} ${LEGACY_DISCLAIMER}` : LEGACY_DISCLAIMER;
    let removeTitle = Boolean(title) && text.trimStart().startsWith(legacyStart);
    let titleRemoved = false;
    // This is the exact old generated sentence. Remove only that sentence from
    // a text token, leaving the title and any real content in the paragraph.
    for (const child of token.children) {
      if (removeTitle && !titleRemoved) {
        if (child.type === 'text' && child.content === title) {
          child.content = '';
          titleRemoved = true;
          continue;
        }
        if (child.type === 'softbreak' || child.type === 'hardbreak') {
          child.hidden = true;
          continue;
        }
      }
      if (child.type !== 'text' || !child.content.includes(LEGACY_DISCLAIMER)) continue;
      child.content = child.content.replace(LEGACY_DISCLAIMER, '').replace(/\n{2,}/g, '\n').trimEnd();
      if (!child.content) token.children.splice(token.children.indexOf(child), 1);
      removeTitle = false;
    }
  }
}

function removeEmptyParagraphs(tokens) {
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].type === 'paragraph_open' && tokens[index + 1].type === 'inline' &&
        !visibleInlineText(tokens[index + 1].children).trim() && tokens[index + 2].type === 'paragraph_close') {
      tokens.splice(index, 3);
      index -= 1;
    }
  }
}

function suppressMatchingTitle(tokens, title) {
  if (!title) return;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].type !== 'heading_open' || tokens[index].tag !== 'h1' ||
        tokens[index + 1].type !== 'inline' || tokens[index + 2].type !== 'heading_close') continue;
    if (visibleInlineText(tokens[index + 1].children).trim() === title) {
      tokens.splice(index, 3);
    }
    return;
  }
}

function suppressLeadingPlainTitle(tokens, title) {
  if (!title || tokens[0]?.type !== 'paragraph_open' || tokens[1]?.type !== 'inline' || tokens[2]?.type !== 'paragraph_close') return;
  const children = tokens[1].children ?? [];
  if (children[0]?.type !== 'text' || children[0].content !== title) return;
  if (children.length > 1 && !['softbreak', 'hardbreak'].includes(children[1].type)) return;
  children.splice(0, children.length > 1 ? 2 : 1);
}

function assignHeadingIds(tokens) {
  const counts = new Map();
  const headings = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const open = tokens[index];
    const inline = tokens[index + 1];
    if (open.type !== 'heading_open' || !['h2', 'h3'].includes(open.tag) || inline.type !== 'inline') continue;
    const text = visibleInlineText(inline.children).trim();
    const base = slugHeading(text);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    open.attrSet('id', id);
    open.meta = { ...(open.meta ?? {}), headingId: id };
    headings.push({ id, text, level: Number(open.tag.slice(1)) });
  }
  return headings;
}

function assignCalloutClasses(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index];
    if (open.type !== 'blockquote_open') continue;
    let inline;
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].type !== 'blockquote_close'; cursor += 1) {
      if (tokens[cursor].type === 'inline') { inline = tokens[cursor]; break; }
    }
    const text = inline ? visibleInlineText(inline.children).trimStart() : '';
    const label = [...CALLOUT_LABELS.keys()].find((candidate) => text.startsWith(candidate));
    if (label) open.attrSet('class', CALLOUT_LABELS.get(label));
  }
}

export function renderMarkdownWithToc(source, videoId, title = '') {
  const renderEngine = new MarkdownIt({ html: false, linkify: false, typographer: false });
  renderEngine.validateLink = () => true;
  const tokens = renderEngine.parse(source, {});
  suppressMatchingTitle(tokens, title);
  suppressLeadingPlainTitle(tokens, title);
  stripLegacyDisclaimer(tokens, title);
  removeEmptyParagraphs(tokens);
  for (const token of tokens) if (token.type === 'inline') linkTimestamps(token.children ?? [], videoId);
  const headings = assignHeadingIds(tokens);
  assignCalloutClasses(tokens);
  const allowedIds = new Set(headings.map(({ id }) => id));
  const originalHeadingClose = renderEngine.renderer.rules.heading_close ?? ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
  renderEngine.renderer.rules.heading_close = (renderTokens, index, options, env, renderer) => {
    const open = renderTokens.slice(0, index).reverse().find((token) => token.type === 'heading_open' && token.level === renderTokens[index].level);
    if (open?.meta?.headingId && allowedIds.has(open.meta.headingId)) {
      return `<a class="heading-anchor" href="#${open.meta.headingId}" aria-label="Link to section">#</a>${originalHeadingClose(renderTokens, index, options, env, renderer)}`;
    }
    return originalHeadingClose(renderTokens, index, options, env, renderer);
  };
  renderEngine.renderer.rules.text = (renderTokens, index) => {
    const token = renderTokens[index];
    if (!token.meta?.timestampParts) return renderEngine.utils.escapeHtml(token.content);
    return token.meta.timestampParts.map((part) => part.href
      ? `<a href="${renderEngine.utils.escapeHtml(part.href)}">${renderEngine.utils.escapeHtml(part.text)}</a>`
      : renderEngine.utils.escapeHtml(part.text)).join('');
  };
  const rendered = renderEngine.renderer.render(tokens, renderEngine.options, {});
  const html = sanitizeHtml(rendered, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title', 'rel', 'target', 'class', 'aria-label'], h2: ['id'], h3: ['id'], blockquote: ['class'] },
    allowedSchemes: ['https'],
    transformTags: {
      a: (_tagName, attributes) => {
        if (attributes.class === 'heading-anchor' && /^#[\p{L}\p{N}-]+$/u.test(attributes.href ?? '') && allowedIds.has(attributes.href.slice(1))) {
          return { tagName: 'a', attribs: { href: attributes.href, class: 'heading-anchor', 'aria-label': attributes['aria-label'] } };
        }
        const href = validateMeetingYoutubeUrl(attributes.href, videoId);
        return { tagName: 'a', attribs: { href, rel: 'noopener noreferrer', target: '_blank' } };
      },
    },
  });
  return { html, headings };
}

export function renderMarkdown(source, videoId, title = '') {
  return renderMarkdownWithToc(source, videoId, title).html;
}
