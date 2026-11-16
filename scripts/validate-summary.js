import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { assertSafeObject, serializeMeeting, validatePayload } from './minutes.js';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 45_000;
const SOURCE_FIELDS = ['date', 'date_source', 'date_verified', 'title', 'video_id'];
const SUMMARY_FIELDS = ['date', 'title', 'video_id'];
const SECTION_LABELS = new Set([
  'At a glance',
  'Meeting information',
  'Decisions and votes',
  'Discussion by agenda item',
  'Public comment',
  'Action items and follow-up',
  'Transcript limitations',
  'Worth a closer look'
]);

function splitFrontmatter(source, label) {
  if (typeof source !== 'string') throw new Error(`${label}_invalid`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${label}_invalid`);
  let metadata;
  try {
    metadata = parse(match[1], { uniqueKeys: true, stringKeys: true });
    assertSafeObject(metadata, label);
  } catch {
    throw new Error(`${label}_invalid`);
  }
  return { metadata, body: match[2] };
}

function parseSourceMetadata(sourceText) {
  const source = splitFrontmatter(sourceText, 'source');
  if (!hasExactKeys(source.metadata, SOURCE_FIELDS) ||
      SOURCE_FIELDS.some((field) => typeof source.metadata[field] !== 'string')) {
    throw new Error('source_metadata_invalid');
  }
  if (source.metadata.date_verified !== 'true' || source.metadata.date_source !== 'title' ||
      !source.metadata.date.trim()) {
    throw new Error('source_date_unverified');
  }
  return source;
}

function decodeQuotedValue(value) {
  return value.replace(/\\(["\\])/g, '$1');
}

function archivedMetadata(firstParagraphText) {
  const match = /^title: "((?:[^"\\]|\\["\\])*)"\s+date: "((?:[^"\\]|\\["\\])*)"\s+video_id: "((?:[^"\\]|\\["\\])*)"$/.exec(firstParagraphText);
  if (!match) throw new Error('archive_metadata_invalid');
  return {
    title: decodeQuotedValue(match[1]),
    date: decodeQuotedValue(match[2]),
    video_id: decodeQuotedValue(match[3])
  };
}

function paragraphMarkdown(paragraph) {
  if (!paragraph || typeof paragraph.text !== 'string' || typeof paragraph.isListItem !== 'boolean' ||
      typeof paragraph.namedStyleType !== 'string') {
    throw new Error('archive_invalid');
  }
  const text = paragraph.text;
  // Workspace Studio's Create Doc step flattens Markdown headings to NORMAL_TEXT paragraphs.
  if (!paragraph.isListItem && /^(Agenda item|Decision|Comment topic): .+$/.test(text)) {
    return `### ${text}`;
  }
  const callout = /^(Look closer|Resident impact|Open question): (.*)$/.exec(text);
  if (callout) return `> **${callout[1]}:** ${callout[2]}`;
  if (SECTION_LABELS.has(text)) return `## ${text}`;
  const heading = /^HEADING_([1-6])$/.exec(paragraph.namedStyleType);
  if (heading && !paragraph.isListItem) return `${'#'.repeat(Number(heading[1]))} ${text}`;
  if (paragraph.isListItem) return `- ${text}`;
  return text;
}

/** Converts Google Docs get_document_text paragraph data without asking a model to rewrite it. */
export function minutesFromArchiveJson(archiveJsonText, sourceText) {
  let source;
  try {
    source = parseSourceMetadata(sourceText);
  } catch (error) {
    return failure(error.message === 'source_date_unverified' ? 'source_date_unverified' : 'source_invalid');
  }

  let archive;
  try {
    archive = JSON.parse(archiveJsonText);
  } catch {
    return failure('archive_invalid');
  }
  if (!archive || typeof archive !== 'object' || !Array.isArray(archive.paragraphs) ||
      archive.paragraphs.length < 2 || typeof archive.paragraphs[0]?.text !== 'string') {
    return failure('archive_invalid');
  }

  let metadata;
  try {
    metadata = archivedMetadata(archive.paragraphs[0].text);
  } catch {
    return failure('archive_metadata_invalid');
  }
  for (const field of SUMMARY_FIELDS) {
    if (metadata[field] !== source.metadata[field]) return failure('source_metadata_mismatch');
  }

  let body;
  try {
    body = archive.paragraphs.slice(1).map(paragraphMarkdown).join('\n\n');
  } catch {
    return failure('archive_invalid');
  }
  const reconstructed = `---\ntitle: ${JSON.stringify(source.metadata.title)}\ndate: ${JSON.stringify(source.metadata.date)}\nvideo_id: ${JSON.stringify(source.metadata.video_id)}\n---\n${body}`;
  return { ok: true, minutesText: reconstructed };
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function markerSet(text) {
  const markers = new Set();
  const expression = /\[(\d{2}:\d{2}:\d{2})\]/g;
  for (const match of text.matchAll(expression)) {
    if (isValidTimestamp(match[1])) markers.add(match[1]);
  }
  return markers;
}

function isValidTimestamp(value) {
  return /^\d{2}:[0-5]\d:[0-5]\d$/.test(value);
}

function findMalformedTimestamps(summaryBody) {
  const invalid = [];
  const seen = new Set();
  const candidates = /\[(\s*[0-9][0-9:.\s]*)\]/g;
  for (const match of summaryBody.matchAll(candidates)) {
    const rawTimestamp = match[1];
    const timestamp = rawTimestamp.trim();
    if (!timestamp.includes(':') || isValidTimestamp(rawTimestamp) || seen.has(timestamp)) continue;
    invalid.push(timestamp);
    seen.add(timestamp);
  }
  return invalid;
}

function findInvalidTimestamps(summaryBody, sourceBody) {
  const sourceMarkers = markerSet(sourceBody);
  const invalid = [];
  const seen = new Set();
  const expression = /\[(\d{2}:\d{2}:\d{2})\]/g;
  for (const match of summaryBody.matchAll(expression)) {
    const timestamp = match[1];
    if (!sourceMarkers.has(timestamp) && !seen.has(timestamp)) {
      invalid.push(timestamp);
      seen.add(timestamp);
    }
  }
  return invalid;
}

function failure(reason, invalidTimestamps = []) {
  return { ok: false, reason, invalid_timestamps: invalidTimestamps };
}

/** Validates summary metadata and every timestamp against the original collector transcript. */
export function validateSummary(sourceText, minutesText) {
  if (typeof sourceText !== 'string' || Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_BYTES) {
    return failure('source_invalid');
  }
  if (typeof minutesText !== 'string' || Buffer.byteLength(minutesText, 'utf8') > MAX_SUMMARY_BYTES) {
    return failure('minutes_invalid');
  }

  let source;
  try {
    source = parseSourceMetadata(sourceText);
  } catch (error) {
    return failure(error.message === 'source_date_unverified' ? 'source_date_unverified' : 'source_invalid');
  }

  if (minutesText.trim() === 'SOURCE_NOT_READY') return failure('source_not_ready');
  let minutes;
  try {
    minutes = splitFrontmatter(minutesText, 'minutes');
  } catch {
    return failure('minutes_invalid');
  }
  if (!hasExactKeys(minutes.metadata, SUMMARY_FIELDS) ||
      SUMMARY_FIELDS.some((field) => typeof minutes.metadata[field] !== 'string')) {
    return failure('minutes_metadata_invalid');
  }
  for (const field of SUMMARY_FIELDS) {
    if (minutes.metadata[field] !== source.metadata[field]) return failure('source_metadata_mismatch');
  }

  const malformedTimestamps = findMalformedTimestamps(minutes.body);
  if (malformedTimestamps.length) return failure('timestamp_format_invalid', malformedTimestamps);

  const invalidTimestamps = findInvalidTimestamps(minutes.body, source.body);
  if (invalidTimestamps.length) return failure('timestamp_not_in_source', invalidTimestamps);

  let payload;
  try {
    payload = validatePayload({
      title: minutes.metadata.title,
      date: minutes.metadata.date,
      video_id: minutes.metadata.video_id,
      markdown: minutesText
    });
  } catch {
    return failure('minutes_invalid');
  }

  return {
    ok: true,
    payload: {
      title: payload.title,
      date: payload.date,
      video_id: payload.video_id,
      // The repository_dispatch contract expects full Markdown with frontmatter.
      markdown: minutesText
    },
    canonicalMarkdown: serializeMeeting(payload),
    summaryBytes: Buffer.byteLength(minutesText, 'utf8')
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--source', '--minutes', '--archive-json', '--dispatch', '--output'].includes(flag) || options[flag]) {
      throw new Error('arguments_invalid');
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('arguments_invalid');
    options[flag] = value;
    index += 1;
  }
  if (!options['--source'] || Boolean(options['--minutes']) === Boolean(options['--archive-json']) ||
      !options['--dispatch']) {
    throw new Error('arguments_invalid');
  }
  return options;
}

async function main(args) {
  let options;
  try {
    options = parseArguments(args);
  } catch {
    process.stdout.write(`${JSON.stringify(failure('arguments_invalid'))}\n`);
    process.exitCode = 1;
    return;
  }

  let sourceText;
  let minutesText;
  try {
    sourceText = await readFile(options['--source'], 'utf8');
    if (options['--minutes']) {
      minutesText = await readFile(options['--minutes'], 'utf8');
    } else {
      const archiveJson = await readFile(options['--archive-json'], 'utf8');
      const archiveResult = minutesFromArchiveJson(archiveJson, sourceText);
      if (!archiveResult.ok) {
        process.stdout.write(`${JSON.stringify(failure(archiveResult.reason))}\n`);
        process.exitCode = 1;
        return;
      }
      minutesText = archiveResult.minutesText;
    }
  } catch {
    process.stdout.write(`${JSON.stringify(failure('input_read_failed'))}\n`);
    process.exitCode = 1;
    return;
  }

  const result = validateSummary(sourceText, minutesText);
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify(failure(result.reason, result.invalid_timestamps))}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    if (options['--output']) await writeFile(options['--output'], result.canonicalMarkdown, { flag: 'w' });
    const dispatch = JSON.stringify({ event_type: 'publish-minutes', client_payload: result.payload });
    await writeFile(options['--dispatch'], `${dispatch}\n`, { flag: 'w' });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      video_id: result.payload.video_id,
      summary_bytes: result.summaryBytes,
      dispatch_bytes: Buffer.byteLength(dispatch, 'utf8'),
      dispatch_file: path.basename(options['--dispatch']),
      ...(options['--output'] ? { output_file: path.basename(options['--output']) } : {})
    })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(failure('output_write_failed'))}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write(`${JSON.stringify(failure('validation_failed'))}\n`);
    process.exitCode = 1;
  });
}
