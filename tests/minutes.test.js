import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  meetingPath,
  parseMeeting,
  renderMarkdown,
  renderMarkdownWithToc,
  serializeMeeting,
  validatePayload,
  validateYoutubeUrl,
} from '../scripts/minutes.js';
import { persistPayload } from '../scripts/ingest-dispatch.js';
import { renderMeetingPage } from '../scripts/build-site.js';

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

test('creates stable Unicode and duplicate section anchors and a matching table of contents', () => {
  const source = '## Café & Community\n\n### Next steps\n\n## Café & Community\n';
  const result = renderMarkdownWithToc(source, videoId);
  assert.deepEqual(result.headings, [
    { id: 'cafe-community', text: 'Café & Community', level: 2 },
    { id: 'next-steps', text: 'Next steps', level: 3 },
    { id: 'cafe-community-2', text: 'Café & Community', level: 2 },
  ]);
  assert.match(result.html, /<h2 id="cafe-community">Café &amp; Community<a href="#cafe-community" class="heading-anchor"/);
  assert.match(result.html, /<h2 id="cafe-community-2">/);
  assert.doesNotMatch(result.html, /javascript:/i);
  assert.equal(renderMarkdownWithToc(source, videoId).html, result.html, 'repeated rendering does not accumulate anchor rules');
});

test('styles only the documented evidence callouts and removes the exact legacy disclaimer', () => {
  const oldDisclaimer = 'Unofficial AI-generated minutes based on a spoken transcript. Not approved by the City of Laurel. Verify decisions against the source and official city records.';
  const html = renderMarkdown(`A title.\n${oldDisclaimer}\n\n> **Look closer:** This is ambiguous.\n\n> **Resident impact:** Example resident effect.\n\n> **Open question:** The record is unclear.\n\n> **Other note:** Keep this.`, videoId);
  assert.doesNotMatch(html, /Unofficial AI-generated minutes based on a spoken transcript/);
  assert.match(html, /class="callout-look-closer"/);
  assert.match(html, /class="callout-resident-impact"/);
  assert.match(html, /class="callout-open-question"/);
  assert.match(html, />\s*<strong>Other note:<\/strong> Keep this\./);
  assert.match(html, /A title\./);
  const prefixed = renderMarkdown(`${title}\n${oldDisclaimer}\n\nA real paragraph follows.`, videoId, title);
  assert.doesNotMatch(prefixed, new RegExp(title));
  assert.doesNotMatch(prefixed, /Unofficial AI-generated minutes/);
  assert.match(prefixed, /A real paragraph follows\./);
});

test('suppresses only a matching plaintext title at the start of the body', () => {
  const nameNote = 'Names follow the transcript; [name uncertain] marks an unverified spelling or identity.';
  const html = renderMarkdown(`${title}\n${nameNote}\n\nThe agenda for ${title} included several items.`, videoId, title);
  assert.equal((html.match(new RegExp(title, 'g')) ?? []).length, 1);
  assert.match(html, /Names follow the transcript; \[name uncertain\] marks an unverified spelling or identity\./);
  assert.match(html, new RegExp(`The agenda for ${title} included several items\\.`));
});

test('links plain timestamps to the source video without rewriting code or existing links', () => {
  const source = 'At [00:15:17] the vote begins. `[00:20:00]` [already linked](https://www.youtube.com/watch?v=' + videoId + '&t=10s).';
  const html = renderMarkdown(source, videoId);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=AbCdEfGhIJK&amp;t=917"[^>]*>\[00:15:17\]<\/a>/);
  assert.match(html, /<code>\[00:20:00\]<\/code>/);
  assert.match(html, /already linked/);
  assert.equal((html.match(/href="https:\/\/www\.youtube\.com\/watch\?v=/g) ?? []).length, 2);
  const repeated = renderMarkdown('[00:15:17] [00:15:17]', videoId);
  assert.equal((repeated.match(/href="https:\/\/www\.youtube\.com\/watch\?v=/g) ?? []).length, 2);
});

test('meeting page places the section navigation before the sections and has one compact AI disclaimer', () => {
  const meeting = {
    title,
    date: '2026-11-15',
    video_id: videoId,
    video_url: `https://www.youtube.com/watch?v=${videoId}`,
    file: `2026-11-15-${videoId}.md`,
    markdown: `Names follow the transcript; [name uncertain] marks an unverified spelling or identity.\n\n## Decisions\n\n> **Open question:** Verify the final vote.\n`,
  };
  const html = renderMeetingPage(meeting);
  assert.ok(html.indexOf('aria-label="On this page"') > html.indexOf('class="prose"'));
  assert.ok(html.indexOf('aria-label="On this page"') < html.indexOf('id="decisions"'));
  assert.match(html, /Names follow the transcript; \[name uncertain\] marks an unverified spelling or identity\./);
  assert.equal((html.match(/Unofficial AI summary\. May contain mistakes; verify against the recording\./g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="notice"/);
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

test('publishing is idempotent per video and refuses changed metadata or content', async (t) => {
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

  const changedTitle = validatePayload(dispatch({
    title: 'Changed title test fixture',
    markdown: markdown.replace(`title: "${title}"`, 'title: "Changed title test fixture"'),
  }));
  const changedDate = validatePayload(dispatch({
    date: '2026-11-16',
    markdown: markdown.replace('date: "2026-11-15"', 'date: "2026-11-16"'),
  }));
  await assert.rejects(persistPayload(changedTitle, root), /second entry for source video/);
  await assert.rejects(persistPayload(changedDate, root), /second entry for source video/);
  assert.deepEqual(await readdir(path.dirname(savedPath)), [path.basename(savedPath)]);

  const changed = validatePayload(dispatch({ markdown: `${frontmatter()}\n\n# Changed test fixture.\n` }));
  await assert.rejects(persistPayload(changed, root), /Refusing to replace existing minutes/);
});

test('rejects a repository dispatch JSON body over GitHub’s 64 KiB limit', () => {
  const oversized = dispatch({ markdown: frontmatter() + '\n\n' + '\n'.repeat(34_000) });
  assert.throws(() => validatePayload(oversized), /64 KiB/);
});

test('meeting page renders one reading column with flags linked to their agenda item', () => {
  const source = [
    '## At a glance', '', '- **Road contract:** Awarded the contract [00:01:00]', '',
    '## Worth a closer look', '',
    '> **Open question:** Topic: Agenda item: Road contract | At [00:01:30], no start date was given. Check the next agenda.', '',
    '## Meeting information', '', '- Date: 2026-11-15', '',
    '## Decisions and votes', '', '### Decision: Road contract', '', 'Motion: Award the contract.', '', 'Result: Motion carries', '',
    'Vote: Smith (Yes)', '', 'Timestamp: [00:01:00]', '',
    '### Decision: Tied item', '', 'Motion: Change the service.', '', 'Result: Result not stated in transcript.', '',
    '## Discussion by agenda item', '', '### Agenda item: Road contract', '', 'What happened: Staff presented bids.', '',
    'Outcome / next step: Contract awarded.', '', 'Timestamp: [00:00:50]', '',
  ].join('\n');
  const html = renderMarkdown(source, videoId);
  assert.doesNotMatch(html, /grid|<details/);
  assert.match(html, /<article class="flag callout-open-question" id="flag-road-contract">/);
  assert.match(html, /<h3 class="flag-title">Road contract<\/h3>/);
  assert.doesNotMatch(html, /Topic: Agenda item/);
  assert.match(html, /<a href="#agenda-item-road-contract" class="flag-link">/);
  assert.match(html, /<a href="#flag-road-contract" class="flag-link">Flagged above/);
  assert.match(html, /<span class="result result-passed">Motion carries<\/span>/);
  assert.match(html, /<span class="result result-unclear">Result not stated in transcript\.<\/span>/);
  assert.ok(html.indexOf('At a glance') < html.indexOf('Worth a closer look'));
  assert.ok(html.indexOf('Worth a closer look') < html.indexOf('aria-label="On this page"'));
  assert.ok(html.indexOf('Discussion by agenda item') < html.indexOf('Meeting information'), 'reference sections move to the end');
});

test('legacy one-line agenda and decision summaries become titled items', () => {
  const source = [
    '## Decisions and votes', '', '- Road Contract (LA 1): Motion to award the contract.', '- Mover: Councilwoman A',
    '- Recorded result: Motion carries (Roll call vote: A - Yes)', '- Timestamp: [00:02:00] - [00:03:00]', '',
    '## Discussion by agenda item', '', '- Road Contract ([00:02:00] - [00:03:00]): Staff presented the bid.', '',
  ].join('\n');
  const html = renderMarkdown(source, videoId);
  assert.match(html, /<h3>Road Contract \(LA 1\)<\/h3><span class="result result-passed">Motion carries<\/span>/);
  assert.match(html, /<span class="field-label">Vote<\/span> Roll call vote: A - Yes/);
  assert.match(html, /<h3 id="agenda-road-contract">Road Contract<\/h3>/);
  assert.match(html, /<p>Staff presented the bid\.<\/p>/);
});
