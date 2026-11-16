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
  'a', 'article', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'header', 'hr', 'li', 'nav', 'ol', 'p', 'pre',
  'section', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'span',
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

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

function promoteExplicitSectionHeadings(tokens) {
  const prefixes = ['Agenda item:', 'Decision:', 'Comment topic:'];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const open = tokens[index];
    const inline = tokens[index + 1];
    const close = tokens[index + 2];
    if (open.type !== 'paragraph_open' || inline.type !== 'inline' || close.type !== 'paragraph_close') continue;
    const first = inline.children?.[0];
    if (first?.type !== 'text') continue;
    const prefix = prefixes.find((candidate) => first.content.startsWith(`${candidate} `));
    if (!prefix) continue;
    open.type = 'heading_open'; open.tag = 'h3'; open.nesting = 1;
    close.type = 'heading_close'; close.tag = 'h3'; close.nesting = -1;
    open.meta = { ...(open.meta ?? {}), displayPrefix: prefix };
    inline.meta = { ...(inline.meta ?? {}), headingPrefix: prefix };
    first.meta = { ...(first.meta ?? {}), headingPrefix: prefix };
  }
}

function assignHeadingIds(tokens) {
  const counts = new Map();
  const headings = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const open = tokens[index];
    const inline = tokens[index + 1];
    if (open.type !== 'heading_open' || !['h2', 'h3'].includes(open.tag) || inline.type !== 'inline') continue;
    const text = visibleInlineText(inline.children).trim();
    const firstText = inline.children?.find((child) => child.type === 'text');
    const headingPrefix = ['Agenda item:', 'Decision:', 'Comment topic:'].find((prefix) => text.startsWith(`${prefix} `));
    if (headingPrefix && firstText) firstText.meta = { ...(firstText.meta ?? {}), headingPrefix };
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

// ---------------------------------------------------------------------------
// Meeting page layout
//
// The page is a single reading column ordered by what a resident needs first:
// the model's key points and flagged items, then formal decisions, then agenda
// detail, then reference material (attendance, limitations). The renderer only
// regroups and relabels source text; it never writes or shortens content.
// ---------------------------------------------------------------------------

const TIMESTAMP_MARKER = /\[(\d{2}):(\d{2}):(\d{2})\]/g;
const HEADING_PREFIXES = ['Agenda item:', 'Decision:', 'Comment topic:'];

function markerSeconds(text) {
  const values = [];
  for (const match of String(text).matchAll(TIMESTAMP_MARKER)) {
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes < 60 && seconds < 60) values.push(Number(match[1]) * 3600 + minutes * 60 + seconds);
  }
  return values;
}

const MONEY = /\$\d[\d,]*(?:\.\d+)?/g;

// Dollar amounts are the figures residents scan for, so they get their own span.
function markMoney(escaped) {
  return escaped.replace(MONEY, (amount) => `<span class="money">${amount}</span>`);
}

function linkTimestampText(text, videoId, escape) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(TIMESTAMP_MARKER)) {
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes > 59 || seconds > 59) continue;
    const total = Number(match[1]) * 3600 + minutes * 60 + seconds;
    html += markMoney(escape(text.slice(last, match.index)));
    html += `<a href="${escape(`https://www.youtube.com/watch?v=${videoId}&t=${total}`)}">${escape(match[0])}</a>`;
    last = match.index + match[0].length;
  }
  return html + markMoney(escape(text.slice(last)));
}

// Breaks a paragraph into its sentences without dropping or changing any text.
// Titles, initials and street abbreviations do not end a sentence.
const NOT_SENTENCE_END = /(?:\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|No|Nos|Inc|Co|Corp|Ltd|Lt|Sgt|Capt|Cpl|Gov|Sen|Rep|Del|Hon|Ave|Rd|Blvd|Mt|vs|approx|U\.S)|(?:^|[\s(])[A-Z])\.$/;

function splitSentences(text) {
  const parts = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]["')\]]?\s+(?=["(\[]?[A-Z0-9])/g)) {
    if (NOT_SENTENCE_END.test(text.slice(start, match.index + 1))) continue;
    parts.push(text.slice(start, match.index + match[0].length).trim());
    start = match.index + match[0].length;
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function lineText(inline) {
  return visibleInlineText(inline?.children ?? []).trim();
}

function withoutHeadingPrefix(text) {
  const prefix = HEADING_PREFIXES.find((candidate) => text.startsWith(`${candidate} `));
  return prefix ? text.slice(prefix.length + 1).trim() : text;
}

function labelOf(inline, labels) {
  const text = lineText(inline);
  return labels.find((label) => text.startsWith(label)) ?? null;
}

// Removes a leading "Label:" written either as plain text or as **Label:**.
function stripLeading(inline, prefix) {
  const children = inline?.children ?? [];
  // markdown-it emits an empty text token before a leading delimiter run.
  while (children[0]?.type === 'text' && !children[0].content) children.shift();
  if (children[0]?.type === 'strong_open' && children[2]?.type === 'strong_close' &&
      visibleInlineText(children.slice(0, 3)).trim() === prefix) {
    children.splice(0, 3);
  } else if (children[0]?.type === 'text' && children[0].content.trimStart().startsWith(prefix)) {
    children[0].content = children[0].content.trimStart().slice(prefix.length);
  } else {
    return false;
  }
  if (children[0]?.type === 'text') children[0].content = children[0].content.trimStart();
  return true;
}

function splitMeetingSections(tokens) {
  const sections = [];
  let current = { heading: [], headingText: '', tokens: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'heading_open' && token.tag === 'h2') {
      if (current.heading.length || current.tokens.length) sections.push(current);
      current = { heading: tokens.slice(index, index + 3), headingText: visibleInlineText(tokens[index + 1]?.children).trim(), tokens: [] };
      index += 2;
    } else current.tokens.push(token);
  }
  if (current.heading.length || current.tokens.length) sections.push(current);
  return sections;
}

const LIST_STRUCTURE = new Set([
  'bullet_list_open', 'bullet_list_close', 'ordered_list_open', 'ordered_list_close', 'list_item_open', 'list_item_close',
]);

// Flattens a section into h3 headings, text lines (paragraphs or list items),
// blockquotes, and any other block kept intact for generic rendering.
function sectionBlocks(tokens) {
  const blocks = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (LIST_STRUCTURE.has(token.type)) continue;
    if (token.type === 'heading_open' && token.tag === 'h3') {
      blocks.push({ kind: 'h3', tokens: tokens.slice(index, index + 3), inline: tokens[index + 1], open: token });
      index += 2;
      continue;
    }
    if (token.type === 'paragraph_open') {
      blocks.push({ kind: 'line', tokens: tokens.slice(index, index + 3), inline: tokens[index + 1] });
      index += 2;
      continue;
    }
    let end = index;
    if (token.nesting === 1) {
      const closeType = token.type.replace(/_open$/, '_close');
      while (end < tokens.length && !(tokens[end].type === closeType && tokens[end].level === token.level)) end += 1;
    }
    const slice = tokens.slice(index, end + 1);
    blocks.push({ kind: token.type === 'blockquote_open' ? 'quote' : 'raw', tokens: slice, inline: slice.find((t) => t.type === 'inline') });
    index = end;
  }
  return blocks;
}

class PageRenderer {
  constructor(engine, videoId) {
    this.engine = engine;
    this.videoId = videoId;
    this.esc = engine.utils.escapeHtml;
    this.inPageIds = new Set();
  }

  tokens(tokens) {
    return this.engine.renderer.render(tokens, this.engine.options, {});
  }

  inline(inline) {
    return inline ? this.engine.renderer.renderInline(inline.children ?? [], this.engine.options, {}) : '';
  }

  linkedText(text) {
    return linkTimestampText(text, this.videoId, this.esc);
  }

  // Plain-text paragraphs with several sentences become a short bulleted list.
  sentences(inline, className = 'sentence-list') {
    const children = inline?.children ?? [];
    if (!children.length || children.some((child) => child.type !== 'text' && child.type !== 'softbreak')) {
      return `<p>${this.inline(inline)}</p>`;
    }
    const parts = splitSentences(children.map((child) => (child.type === 'text' ? child.content : ' ')).join(''));
    if (parts.length < 2) return `<p>${this.inline(inline)}</p>`;
    return `<ul class="${className}">${parts.map((part) => `<li>${this.linkedText(part)}</li>`).join('')}</ul>`;
  }

  // Renders a block standalone; list-item paragraphs become ordinary paragraphs.
  block(block) {
    if (block.kind === 'line') return `<p>${this.inline(block.inline)}</p>`;
    if (block.kind === 'h3') return this.tokens(block.tokens);
    return this.tokens(block.tokens);
  }

  uniqueId(base) {
    let id = base;
    for (let suffix = 2; this.inPageIds.has(id); suffix += 1) id = `${base}-${suffix}`;
    this.inPageIds.add(id);
    return id;
  }
}

// ---- Decisions -----------------------------------------------------------

const DECISION_FIELDS = new Map([
  ['Exact action proposed:', 'motion'], ['Motion:', 'motion'], ['Mover:', 'mover'], ['Moved by:', 'mover'],
  ['Seconder:', 'seconder'], ['Seconded by:', 'seconder'], ['Recorded result:', 'result'], ['Result:', 'result'],
  ['Individual votes:', 'vote'], ['Vote:', 'vote'], ['Timestamp:', 'time'],
]);

// Older summaries put the subject and motion on one line: "Subject (No. 1): Motion to ...".
function splitLegacyDecisionTitle(inline) {
  const first = inline?.children?.[0];
  if (first?.type !== 'text') return null;
  const candidates = ['): ', ': Motion to ', ': Motion ']
    .map((delimiter) => ({ delimiter, index: first.content.indexOf(delimiter) }))
    .filter((match) => match.index > 0)
    .sort((a, b) => a.index - b.index);
  const match = candidates[0];
  if (!match) return null;
  const closesParen = match.delimiter.startsWith('):');
  const title = first.content.slice(0, closesParen ? match.index + 1 : match.index).trim();
  first.content = first.content.slice(closesParen ? match.index + match.delimiter.length : match.index + 2);
  return title;
}

function parseDecisions(blocks) {
  const intro = [];
  const groups = [];
  let current = null;
  for (const block of blocks) {
    if (block.kind === 'h3') {
      current = { title: withoutHeadingPrefix(lineText(block.inline)), id: block.open.attrGet('id'), fields: {}, extra: [] };
      groups.push(current);
      continue;
    }
    if (block.kind === 'line') {
      const label = labelOf(block.inline, [...DECISION_FIELDS.keys()]);
      if (label) {
        if (!current) { current = { title: null, fields: {}, extra: [] }; groups.push(current); }
        stripLeading(block.inline, label);
        current.fields[DECISION_FIELDS.get(label)] = block.inline;
        continue;
      }
      const legacyTitle = splitLegacyDecisionTitle(block.inline);
      if (legacyTitle) {
        current = { title: legacyTitle, fields: { motion: block.inline }, extra: [] };
        groups.push(current);
        continue;
      }
    }
    (current ? current.extra : intro).push(block);
  }
  return { intro, groups };
}

// Classifies only the explicit result wording; it never derives a result from vote counts.
function resultTone(text) {
  if (/\b(not stated|unclear|no result|not announced)\b/i.test(text)) return 'unclear';
  if (/\b(fail|fails|failed|defeated|denied|rejected)\b/i.test(text)) return 'failed';
  if (/\b(carries|carried|approved|adopted|passes|passed)\b/i.test(text)) return 'passed';
  return 'unclear';
}

// Splits "Motion carries (Roll call vote: ...)" into the result and its vote detail.
function decisionResult(group) {
  if (!group.fields.result) return null;
  const text = lineText(group.fields.result);
  const paren = text.indexOf(' (');
  const split = paren > 0 && text.endsWith(')');
  const label = split ? text.slice(0, paren) : text;
  return { label, tone: resultTone(label), detail: split ? text.slice(paren + 2, -1) : '' };
}

function resultBadge(result, page) {
  const mark = { passed: '✓ ', failed: '✕ ', unclear: '' }[result.tone];
  return `<span class="result result-${result.tone}">${mark}${page.linkedText(result.label)}</span>`;
}

function renderDecisions(parsed, page) {
  const { intro, groups } = parsed;
  if (!groups.length || groups.every((group) => !Object.keys(group.fields).length)) return null;
  const items = groups.map((group) => {
    const { fields } = group;
    const result = decisionResult(group);
    let voteDetail = fields.vote ? page.inline(fields.vote) : '';
    if (result?.detail && !voteDetail) voteDetail = page.linkedText(result.detail);
    const badge = result ? resultBadge(result, page) : '';
    const meta = [];
    if (fields.mover) meta.push(`Moved by ${page.inline(fields.mover)}`);
    if (fields.seconder) meta.push(`seconded by ${page.inline(fields.seconder)}`);
    if (fields.time) meta.push(page.inline(fields.time));
    const titleHtml = group.title ? page.esc(group.title) : 'Decision';
    const idAttr = group.id ? ` id="${page.esc(group.id)}"` : '';
    return `<li class="decision">
<div class="decision-head"><h3${idAttr}>${titleHtml}</h3>${badge}</div>
${fields.motion ? `<p class="decision-motion">${page.inline(fields.motion)}</p>` : ''}
${voteDetail ? `<p class="decision-vote"><span class="field-label">Vote</span> ${voteDetail}</p>` : ''}
${meta.length ? `<p class="decision-meta">${meta.join(' · ')}</p>` : ''}
${group.extra.map((block) => page.block(block)).join('')}
</li>`;
  });
  return `${intro.map((block) => page.block(block)).join('')}<ol class="decision-list">${items.join('')}</ol>`;
}

// ---- Agenda items --------------------------------------------------------

const AGENDA_FIELDS = new Map([
  ['What happened:', 'what'], ['Resident relevance:', 'relevance'], ['Outcome / next step:', 'outcome'], ['Timestamp:', 'time'],
]);
const LEGACY_AGENDA_LINE = /^(.+?) \((\[\d{2}:\d{2}:\d{2}\])(?:\s*[-–]\s*(\[\d{2}:\d{2}:\d{2}\]))?\):\s*/;

function parseAgenda(blocks, page) {
  const intro = [];
  const items = [];
  let current = null;
  for (const block of blocks) {
    if (block.kind === 'h3') {
      const headingText = lineText(block.inline);
      current = { headingText, title: withoutHeadingPrefix(headingText), id: block.open.attrGet('id'), fields: {}, extra: [] };
      items.push(current);
      continue;
    }
    if (block.kind === 'line') {
      const label = labelOf(block.inline, [...AGENDA_FIELDS.keys()]);
      if (label && current) {
        stripLeading(block.inline, label);
        current.fields[AGENDA_FIELDS.get(label)] = block.inline;
        continue;
      }
      const first = block.inline?.children?.[0];
      const legacy = first?.type === 'text' ? LEGACY_AGENDA_LINE.exec(first.content) : null;
      if (legacy) {
        first.content = first.content.slice(legacy[0].length);
        const times = [legacy[2], legacy[3]].filter(Boolean);
        current = {
          headingText: legacy[1].trim(), title: legacy[1].trim(), id: page.uniqueId(`agenda-${slugHeading(legacy[1])}`),
          legacyTimes: times, fields: { what: block.inline }, extra: [],
        };
        items.push(current);
        continue;
      }
    }
    (current ? current.extra : intro).push(block);
  }
  // Time ranges let a callout without an exact Topic field find its agenda item.
  items.forEach((item, index) => {
    if (item.legacyTimes) {
      const seconds = markerSeconds(item.legacyTimes.join(' '));
      item.start = seconds[0];
      item.end = seconds.at(-1);
    } else {
      item.start = markerSeconds(lineText(item.fields.time))[0];
      const next = items.slice(index + 1).map((other) => markerSeconds(lineText(other.fields.time))[0]).find(Number.isSafeInteger);
      item.end = Number.isSafeInteger(next) ? next - 1 : item.start;
    }
  });
  return { intro, items };
}

// The kind is read from the agenda item's own title; it adds a label, never a claim.
const AGENDA_KINDS = [
  [/public (hearing|comment)|citizen comment/i, 'hearing', '📣', 'Public comment'],
  [/ordinance/i, 'law', '📜', 'Ordinance'],
  [/charter amendment/i, 'law', '📜', 'Charter amendment'],
  [/resolution/i, 'law', '📜', 'Resolution'],
  [/\b(bid|contract|agreement|purchase|award)/i, 'money', '💵', 'Spending'],
  [/report|roll call|announcement|proclamation/i, 'reports', '🎙️', 'Reports'],
];

function agendaKind(title) {
  const match = AGENDA_KINDS.find(([pattern]) => pattern.test(title));
  return match ? { key: match[1], icon: match[2], label: match[3] } : null;
}

// A decision belongs to an agenda item when its first timestamp falls inside the item's range.
function attachDecisions(items, groups) {
  for (const group of groups) {
    const result = decisionResult(group);
    const start = markerSeconds(lineText(group.fields.time))[0];
    if (!result || !Number.isSafeInteger(start)) continue;
    // Adjacent items share a boundary second, so an item starting exactly at the vote wins.
    const exact = items.filter((item) => item.start === start);
    const owners = exact.length ? exact
      : items.filter((item) => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && start >= item.start && start <= item.end);
    if (owners.length === 1) (owners[0].results ??= []).push(result);
  }
}

function renderAgenda(parsed, page) {
  const { intro, items } = parsed;
  if (!items.length) return null;
  const rendered = items.map((item) => {
    const { fields } = item;
    const kind = agendaKind(item.title);
    const chips = [
      kind ? `<span class="kind-chip"><span aria-hidden="true">${kind.icon}</span> ${kind.label}</span>` : '',
      ...(item.results ?? []).map((result) => resultBadge(result, page)),
    ].join('');
    const when = item.legacyTimes
      ? item.legacyTimes.map((time) => page.linkedText(time)).join(' – ')
      : fields.time ? page.inline(fields.time) : '';
    const flags = (item.flags ?? []).map((id) => `<a class="flag-link" href="#${page.esc(id)}">Flagged above ↑</a>`).join(' ');
    return `<li class="agenda-item kind-${kind?.key ?? 'other'}${item.flags?.length ? ' agenda-item-flagged' : ''}">
<div class="agenda-head"><h3 id="${page.esc(item.id)}">${page.esc(item.title)}</h3>${when ? `<span class="agenda-when">${when}</span>` : ''}</div>
${chips ? `<p class="agenda-chips">${chips}</p>` : ''}
${flags ? `<p class="agenda-flags">${flags}</p>` : ''}
${fields.what ? page.sentences(fields.what) : ''}
${fields.outcome ? `<p class="agenda-outcome"><span class="field-label">Outcome</span> ${page.inline(fields.outcome)}</p>` : ''}
${fields.relevance ? `<p class="agenda-relevance"><span class="field-label">For residents</span> ${page.inline(fields.relevance)}</p>` : ''}
${item.extra.map((block) => page.block(block)).join('')}
</li>`;
  });
  return `${intro.map((block) => page.block(block)).join('')}<ol class="agenda-list">${rendered.join('')}</ol>`;
}

// ---- Flagged items ("Worth a closer look") -------------------------------

function calloutLabel(inline) {
  return labelOf(inline, [...CALLOUT_LABELS.keys()]);
}

function renderFlags(blocks, agendaItems, page) {
  const flags = blocks.filter((block) => block.kind === 'quote' && calloutLabel(block.inline));
  if (!flags.length) return null;
  const out = blocks.map((block) => {
    if (!flags.includes(block)) return page.block(block);
    const { inline } = block;
    const label = calloutLabel(inline);
    stripLeading(inline, label);
    let topic = null;
    let target = null;
    const first = inline.children?.[0];
    const topicMatch = first?.type === 'text' ? /^Topic: (.+?) \| /.exec(first.content) : null;
    if (topicMatch) {
      topic = topicMatch[1].trim();
      first.content = first.content.slice(topicMatch[0].length);
      const exact = agendaItems.filter((item) => item.headingText === topic);
      if (exact.length === 1) target = exact[0];
    }
    if (!target) {
      const times = markerSeconds(lineText(inline));
      const candidates = agendaItems.filter((item) => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) &&
        times.some((time) => time >= item.start && time <= item.end));
      if (candidates.length === 1) target = candidates[0];
    }
    const id = page.uniqueId(`flag-${slugHeading(target?.title ?? label)}`);
    if (target) (target.flags ??= []).push(id);
    const title = target?.title ?? (topic ? withoutHeadingPrefix(topic) : null);
    return `<article class="flag ${CALLOUT_LABELS.get(label)}" id="${id}">
<p class="flag-label">${page.esc(label.slice(0, -1))}</p>
${title ? `<h3 class="flag-title">${page.esc(title)}</h3>` : ''}
<p>${page.inline(inline)}</p>
${target ? `<a class="flag-link" href="#${page.esc(target.id)}">Go to this agenda item ↓</a>` : ''}
</article>`;
  });
  return out.join('');
}

// ---- Action items --------------------------------------------------------

function renderActions(blocks, page) {
  if (!blocks.some((block) => block.kind === 'line' && labelOf(block.inline, ['Assignment:']))) return null;
  const items = [];
  const other = [];
  let current = null;
  for (const block of blocks) {
    const label = block.kind === 'line' ? labelOf(block.inline, ['Assignment:', 'Owner:', 'Deadline:']) : null;
    if (label === 'Assignment:') {
      stripLeading(block.inline, label);
      current = { task: block.inline, meta: [] };
      items.push(current);
    } else if (label && current) {
      stripLeading(block.inline, label);
      if (!/^not specified\.?$/i.test(lineText(block.inline))) current.meta.push(`${label.slice(0, -1)}: ${page.inline(block.inline)}`);
    } else other.push(block);
  }
  return `<ul class="action-list">${items.map((item) => `<li>${page.inline(item.task)}${item.meta.length ? ` <span class="action-meta">${item.meta.join(' · ')}</span>` : ''}</li>`).join('')}</ul>${other.map((block) => page.block(block)).join('')}`;
}

// ---- Page assembly -------------------------------------------------------

const TOP_SECTIONS = ['at a glance', 'worth a closer look'];
const REFERENCE_SECTIONS = ['meeting information', 'transcript limitations'];

function renderStructuredSections(tokens, page) {
  const sections = splitMeetingSections(tokens);
  const named = sections.filter((section) => section.heading.length);
  if (!named.length) return page.tokens(tokens);

  const byTitle = new Map(named.map((section) => [section.headingText.toLowerCase(), section]));
  const agendaSection = byTitle.get('discussion by agenda item');
  const agenda = agendaSection ? parseAgenda(sectionBlocks(agendaSection.tokens), page) : { intro: [], items: [] };
  const decisionSection = byTitle.get('decisions and votes');
  const decisions = decisionSection ? parseDecisions(sectionBlocks(decisionSection.tokens)) : { intro: [], groups: [] };
  attachDecisions(agenda.items, decisions.groups);

  // Flags are rendered before agenda items so agenda items can link back to them.
  const bodies = new Map();
  const worth = byTitle.get('worth a closer look');
  if (worth) bodies.set(worth, renderFlags(sectionBlocks(worth.tokens), agenda.items, page));
  for (const section of named) {
    const title = section.headingText.toLowerCase();
    if (section === worth) continue;
    let body = null;
    if (section === decisionSection) body = renderDecisions(decisions, page);
    else if (section === agendaSection) body = renderAgenda(agenda, page);
    else if (title === 'action items and follow-up') body = renderActions(sectionBlocks(section.tokens), page);
    bodies.set(section, body);
  }

  const renderSection = (section) => {
    const slug = slugHeading(section.headingText);
    const body = bodies.get(section) ?? page.tokens(section.tokens);
    return `<section class="meeting-section section-${slug}">${page.tokens(section.heading)}${body}</section>`;
  };

  const preamble = sections.find((section) => !section.heading.length);
  const top = named.filter((section) => TOP_SECTIONS.includes(section.headingText.toLowerCase()))
    .sort((a, b) => TOP_SECTIONS.indexOf(a.headingText.toLowerCase()) - TOP_SECTIONS.indexOf(b.headingText.toLowerCase()));
  const reference = named.filter((section) => REFERENCE_SECTIONS.includes(section.headingText.toLowerCase()));
  const main = named.filter((section) => !top.includes(section) && !reference.includes(section));
  const navSections = [...main, ...reference];
  const nav = navSections.length
    ? `<nav class="page-nav" aria-label="On this page"><span class="page-nav-title">On this page</span>${navSections
      .map((section) => `<a class="page-nav-link" href="#${page.esc(section.heading[0].attrGet('id'))}">${page.esc(section.headingText)}</a>`).join('')}</nav>`
    : '';
  const hasKnownLayout = top.length || reference.length || byTitle.has('decisions and votes') || agendaSection;
  const preambleHtml = preamble ? page.tokens(preamble.tokens) : '';

  return [
    hasKnownLayout ? '' : preambleHtml,
    top.length ? `<div class="briefing">${top.map(renderSection).join('')}</div>` : '',
    nav,
    main.map(renderSection).join(''),
    reference.length || (hasKnownLayout && preambleHtml)
      ? `<div class="reference">${reference.map(renderSection).join('')}${hasKnownLayout ? `<div class="record-note">${preambleHtml}</div>` : ''}</div>`
      : '',
  ].join('');
}

function assignCalloutClasses(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'blockquote_open') continue;
    const inline = tokens.slice(index).find((token) => token.type === 'inline');
    const label = calloutLabel(inline);
    if (label) tokens[index].attrSet('class', CALLOUT_LABELS.get(label));
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
  promoteExplicitSectionHeadings(tokens);
  const headings = assignHeadingIds(tokens);
  assignCalloutClasses(tokens);
  const page = new PageRenderer(renderEngine, videoId);
  for (const { id } of headings) page.inPageIds.add(id);

  const originalHeadingClose = renderEngine.renderer.rules.heading_close ?? ((t, i, options, env, renderer) => renderer.renderToken(t, i, options));
  renderEngine.renderer.rules.heading_close = (renderTokens, index, options, env, renderer) => {
    const open = renderTokens.slice(0, index).reverse().find((token) => token.type === 'heading_open' && token.level === renderTokens[index].level);
    if (open?.meta?.headingId) {
      return `<a class="heading-anchor" href="#${open.meta.headingId}" aria-label="Link to section">#</a>${originalHeadingClose(renderTokens, index, options, env, renderer)}`;
    }
    return originalHeadingClose(renderTokens, index, options, env, renderer);
  };
  renderEngine.renderer.rules.text = (renderTokens, index) => {
    const token = renderTokens[index];
    let content = token.content;
    const prefix = token.meta?.headingPrefix;
    if (prefix && content.startsWith(`${prefix} `)) content = content.slice(prefix.length + 1);
    let linkDepth = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      if (renderTokens[cursor].type === 'link_open') linkDepth += 1;
      else if (renderTokens[cursor].type === 'link_close') linkDepth -= 1;
    }
    return linkDepth > 0 ? page.esc(content) : page.linkedText(content);
  };

  const rendered = renderStructuredSections(tokens, page);
  const inPageClasses = ['heading-anchor', 'flag-link', 'page-nav-link'];
  const html = sanitizeHtml(rendered, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target', 'class', 'aria-label'], h2: ['id', 'class'], h3: ['id', 'class'], blockquote: ['class', 'id'],
      article: ['class', 'id'], div: ['class'], span: ['class', 'aria-hidden'], section: ['class'], nav: ['aria-label', 'class'],
      p: ['class'], li: ['class'], ol: ['class'], ul: ['class'],
    },
    allowedSchemes: ['https'],
    transformTags: {
      a: (_tagName, attributes) => {
        if (inPageClasses.includes(attributes.class) && /^#[\p{L}\p{N}-]+$/u.test(attributes.href ?? '') && page.inPageIds.has(attributes.href.slice(1))) {
          return { tagName: 'a', attribs: { href: attributes.href, class: attributes.class, ...(attributes['aria-label'] ? { 'aria-label': attributes['aria-label'] } : {}) } };
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
