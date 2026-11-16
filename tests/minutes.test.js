import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  meetingPath,
  parseMeeting,
  renderMarkdown,
  serializeMeeting,
  validatePayload,
  validateYoutubeUrl,
} from '../scripts/minutes.js';
import { persistPayload } from '../scripts/ingest-dispatch.js';

const videoId = 'AbCdEfGhIJK';
const title = 'Input validation test fixture';
const frontmatter = (fields = {}) => `---\ntitle: "${title}"\ndate: "2026-11-15"\nvideo_id: "${videoId}"\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}${Object.keys(fields).length ? '\n' : ''}---`;
const markdown = `${frontmatter()}

# ${title}

A sample summary with a [source timestamp](https://www.youtube.com/watch?v=${videoId}&t=1m20s).
`;
const dispatch = (changes = {}) => ({ title, date: '2026-11-15', video_id: videoId, markdown, ...changes });

test('uses a safe, deterministic filename that includes the source video ID', () => {
  const first = validatePayload(dispatch());
  const second = validatePayload(dispatch());
  assert.equal(first.file, `src/content/meetings/2026-11-15-input-validation-test-fixture-${videoId}.md`);
  assert.equal(first.file, second.file);
  assert.equal(first.markdown, `# ${title}\n\nA sample summary with a [source timestamp](https://www.youtube.com/watch?v=${videoId}&t=1m20s).\n`);
  assert.equal(meetingPath({ title: '../../bad', date: '2026-11-15', video_id: videoId }), `src/content/meetings/2026-11-15-bad-${videoId}.md`);
});

test('rejects malformed dates, unsafe IDs, extra keys, and prototype keys', () => {
  assert.throws(() => validatePayload(dispatch({ date: '2026-02-30' })), /real calendar date/);
  assert.throws(() => validatePayload(dispatch({ date: '../2026-11-15' })), /YYYY-MM-DD/);
  assert.throws(() => validatePayload(dispatch({ video_id: '../etc/passwd' })), /YouTube video ID/);
  assert.throws(() => validatePayload(dispatch({ extra: 'not allowed' })), /exactly title, date, video_id, and markdown/);
  const polluted = JSON.parse('{"title":"fixture","date":"2026-11-15","video_id":"AbCdEfGhIJK","markdown":"x","__proto__":{"polluted":true}}');
  assert.throws(() => validatePayload(polluted), /forbidden key/);
  assert.equal({}.polluted, undefined);
});

test('requires Gemini metadata to match the dispatch envelope exactly', () => {
  assert.throws(() => validatePayload(dispatch({ markdown: markdown.replace(`date: "2026-11-15"`, `date: "2026-11-14"`) })), /must match the dispatch/);
  assert.throws(() => validatePayload(dispatch({ markdown: markdown.replace(`title: "${title}"`, 'title: "Other title"') })), /must match the dispatch/);
  assert.throws(() => validatePayload(dispatch({ markdown: 'SOURCE_NOT_READY' })), /YAML frontmatter/);
  assert.throws(() => validatePayload(dispatch({ markdown: markdown.replace(`video_id: "${videoId}"`, `__proto__: { polluted: true }\nvideo_id: "${videoId}"`) })), /forbidden key/);
});

test('accepts only YouTube recording links and valid timestamps for the same video', () => {
  assert.equal(validateYoutubeUrl(`https://youtu.be/${videoId}?t=80`), `https://youtu.be/${videoId}?t=80`);
  for (const href of [
    'javascript:alert(1)',
    'https://example.com/watch?v=AbCdEfGhIJK',
    'http://youtube.com/watch?v=AbCdEfGhIJK',
    'https://www.youtube.com/watch?v=AbCdEfGhIJK&t=1m90s',
  ]) {
    const unsafe = markdown.replace(`https://www.youtube.com/watch?v=${videoId}&t=1m20s`, href);
    assert.throws(() => validatePayload(dispatch({ markdown: unsafe })), /YouTube/, href);
  }
  const otherVideo = markdown.replace(`v=${videoId}`, 'v=OtherVideo1');
  assert.throws(() => validatePayload(dispatch({ markdown: otherVideo })), /source video/);
});

test('escapes raw HTML and sanitizes generated markdown output', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\nA <img src=x onerror=alert(1)> [recording](https://youtu.be/' + videoId + ')', videoId);
  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(renderMarkdown(`# ${title}\n\nContent.`, videoId, title), /<h1>/);
  assert.throws(() => validatePayload(dispatch({ markdown: markdown.replace(`# ${title}`, `![image](https://youtu.be/${videoId})\n\n# ${title}`) })), /images are not allowed/);
});

test('serializes stable source metadata and reads it back for site generation', () => {
  const payload = validatePayload(dispatch());
  const serialized = serializeMeeting(payload);
  const parsed = parseMeeting(serialized, 'fixture.md');
  assert.equal(parsed.title, title);
  assert.equal(parsed.video_id, videoId);
  assert.equal(parsed.video_url, `https://www.youtube.com/watch?v=${videoId}`);
  assert.match(serialized, /Unofficial AI-generated summary/);
});

test('publishing is idempotent and refuses a conflicting replacement', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'laurel-minutes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = validatePayload(dispatch());
  const created = await persistPayload(payload, root);
  const savedPath = path.join(root, payload.file);
  const original = await readFile(savedPath, 'utf8');
  const repeated = await persistPayload(payload, root);
  assert.equal(created.created, true);
  assert.equal(repeated.created, false);
  assert.equal(await readFile(savedPath, 'utf8'), original);
  const changed = validatePayload(dispatch({ markdown: `${frontmatter()}\n\n# Changed test fixture.\n` }));
  await assert.rejects(persistPayload(changed, root), /Refusing to replace existing minutes/);
});

test('rejects a repository dispatch JSON body over GitHub’s 64 KiB limit', () => {
  const oversized = dispatch({ markdown: frontmatter() + '\n\n' + '\n'.repeat(34_000) });
  assert.throws(() => validatePayload(oversized), /64 KiB/);
});
