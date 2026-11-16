import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { renderMarkdown } from '../scripts/minutes.js';
import { minutesFromArchiveJson, validateSummary } from '../scripts/validate-summary.js';

const source = `---
title: "Mayor and City Council Meeting"
date: "2026-11-14"
video_id: "abcdefghijk"
date_source: "title"
date_verified: "true"
---
[00:00:04] Call to order.
[00:15:16] The Council discussed the budget.
[00:22:09] The meeting continued.
`;

const minutes = `---
title: "Mayor and City Council Meeting"
date: "2026-11-14"
video_id: "abcdefghijk"
---
# Mayor and City Council Meeting

## Discussion by agenda item
- [00:00:04] The meeting was called to order.
- [00:15:16] The Council discussed the budget.
- [00:22:09] The meeting continued.
`;

test('accepts metadata and timestamps grounded in the original transcript', () => {
  const result = validateSummary(source, minutes);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    title: 'Mayor and City Council Meeting',
    date: '2026-11-14',
    video_id: 'abcdefghijk',
    markdown: minutes
  });
  assert.match(result.canonicalMarkdown, /video_url: https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk/);
});

test('rejects the observed unsupported [00:15:17] marker without changing it', () => {
  const unsupported = minutes.replace('[00:15:16]', '[00:15:17]');
  const result = validateSummary(source, unsupported);
  assert.deepEqual(result, {
    ok: false,
    reason: 'timestamp_not_in_source',
    invalid_timestamps: ['00:15:17']
  });
});

test('rejects malformed bracketed time tokens instead of silently ignoring them', () => {
  for (const [token, expected] of [
    ['[016:56]', '016:56'],
    ['[16:56]', '16:56'],
    ['[00:16:56.2]', '00:16:56.2'],
    ['[1:02:03]', '1:02:03'],
    ['[00:99:00]', '00:99:00'],
    ['[ 00:16:56]', '00:16:56'],
    ['[00:16:56 ]', '00:16:56']
  ]) {
    const result = validateSummary(source, minutes.replace('[00:15:16]', token));
    assert.deepEqual(result, {
      ok: false,
      reason: 'timestamp_format_invalid',
      invalid_timestamps: [expected]
    });
  }
});

test('accepts only valid source markers while allowing names and ordinary link labels', () => {
  const text = minutes.replace(
    'The meeting continued.',
    'The clerk [name uncertain] continued at [topic: 2026](https://www.youtube.com/watch?v=abcdefghijk).'
  );
  assert.equal(validateSummary(source, text).ok, true);
  assert.equal(validateSummary(source, minutes.replace('[00:15:16]', '[00:99:00]')).reason,
    'timestamp_format_invalid');
});

test('requires source metadata and verified source dates to match the summary', () => {
  assert.equal(validateSummary(source.replace('date_verified: "true"', 'date_verified: "false"'), minutes).reason,
    'source_date_unverified');
  assert.equal(validateSummary(source.replace('date: "2026-11-14"', 'date: "2026-11-13"'), minutes).reason,
    'source_metadata_mismatch');
});

test('rejects SOURCE_NOT_READY and unsafe minutes before producing a dispatch payload', () => {
  assert.equal(validateSummary(source, 'SOURCE_NOT_READY').reason, 'source_not_ready');
  const invalidLink = minutes.replace('The meeting continued.', '[Other](https://example.com)');
  assert.equal(validateSummary(source, invalidLink).reason, 'minutes_invalid');
});

test('rebuilds frontmatter from matching archived metadata and preserves paragraph/list text', () => {
  const archive = {
    paragraphs: [
      {
        text: 'title: "Mayor and City Council Meeting" date: "2026-11-14" video_id: "abcdefghijk"',
        namedStyleType: 'NORMAL_TEXT',
        isListItem: false
      },
      { text: 'Mayor and City Council Meeting', namedStyleType: 'HEADING_1', isListItem: false },
      { text: 'Discussion by agenda item', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: '[00:15:16] Budget discussion.', namedStyleType: 'NORMAL_TEXT', isListItem: true }
    ]
  };
  const result = minutesFromArchiveJson(JSON.stringify(archive), source);
  assert.equal(result.ok, true);
  assert.match(result.minutesText, /^---\ntitle: "Mayor and City Council Meeting"\ndate: "2026-11-14"\nvideo_id: "abcdefghijk"\n---/);
  assert.match(result.minutesText, /# Mayor and City Council Meeting\n\n## Discussion by agenda item\n\n- \[00:15:16\] Budget discussion\./);
  assert.equal(validateSummary(source, result.minutesText).ok, true);
});

test('rejects an archived metadata triple that does not exactly match source metadata', () => {
  const archive = {
    paragraphs: [
      {
        text: 'title: "Mayor and City Council Meeting" date: "2026-11-14" video_id: "wrongVideo1"',
        namedStyleType: 'NORMAL_TEXT',
        isListItem: false
      },
      { text: 'Body', namedStyleType: 'NORMAL_TEXT', isListItem: false }
    ]
  };
  assert.deepEqual(minutesFromArchiveJson(JSON.stringify(archive), source), {
    ok: false,
    reason: 'source_metadata_mismatch',
    invalid_timestamps: []
  });
});

test('promotes only exact known section labels to second-level headings', () => {
  const archive = {
    paragraphs: [
      {
        text: 'title: "Mayor and City Council Meeting" date: "2026-11-14" video_id: "abcdefghijk"',
        namedStyleType: 'NORMAL_TEXT',
        isListItem: false
      },
      { text: 'At a glance', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'At a glance, the meeting covered these topics.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Worth a closer look', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Worth a closer look at these details.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Meeting information', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'The Meeting information section lists attendance.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Decisions and votes', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Discussion by agenda item', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Public comment', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Action items and follow-up', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Transcript limitations', namedStyleType: 'NORMAL_TEXT', isListItem: false }
    ]
  };
  const result = minutesFromArchiveJson(JSON.stringify(archive), source);
  assert.equal(result.ok, true);
  assert.match(result.minutesText, /## At a glance\n\nAt a glance, the meeting covered these topics\.\n\n## Worth a closer look\n\nWorth a closer look at these details\.\n\n## Meeting information\n\nThe Meeting information section lists attendance\.\n\n## Decisions and votes\n\n## Discussion by agenda item\n\n## Public comment\n\n## Action items and follow-up\n\n## Transcript limitations/);
});

test('restores agenda, decision, and comment headings only from exact paragraph prefixes', () => {
  const archive = {
    paragraphs: [
      {
        text: 'title: "Mayor and City Council Meeting" date: "2026-11-14" video_id: "abcdefghijk"',
        namedStyleType: 'NORMAL_TEXT',
        isListItem: false
      },
      { text: 'Agenda item: Waste collection', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'The Agenda item: prefix appears in this sentence.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Decision: Contract renewal', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'The Decision: prefix appears in this sentence.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Comment topic: Voting access', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'The Comment topic: prefix appears in this sentence.', namedStyleType: 'NORMAL_TEXT', isListItem: false }
    ]
  };
  const result = minutesFromArchiveJson(JSON.stringify(archive), source);
  assert.equal(result.ok, true);
  assert.match(result.minutesText,
    /### Agenda item: Waste collection\n\nThe Agenda item: prefix appears in this sentence\.\n\n### Decision: Contract renewal\n\nThe Decision: prefix appears in this sentence\.\n\n### Comment topic: Voting access\n\nThe Comment topic: prefix appears in this sentence\./);
});

test('restores only exact callout-label prefixes from the archived plain text', () => {
  const archive = {
    paragraphs: [
      {
        text: 'title: "Mayor and City Council Meeting" date: "2026-11-14" video_id: "abcdefghijk"',
        namedStyleType: 'NORMAL_TEXT',
        isListItem: false
      },
      { text: 'Agenda item: Budget', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Look closer: Topic: Agenda item: Budget | At [00:15:16], the Council discussed the budget.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'The Resident impact: label appears later in this sentence.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Resident impact: At [00:22:09], the Council discussed the timeline.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Open question: At [00:15:16], no date was stated.', namedStyleType: 'NORMAL_TEXT', isListItem: false }
    ]
  };
  const result = minutesFromArchiveJson(JSON.stringify(archive), source);
  assert.equal(result.ok, true);
  assert.match(result.minutesText,
    /### Agenda item: Budget\n\n> \*\*Look closer:\*\* Topic: Agenda item: Budget \| At \[00:15:16\], the Council discussed the budget\.\n\nThe Resident impact: label appears later in this sentence\.\n\n> \*\*Resident impact:\*\* At \[00:22:09\], the Council discussed the timeline\.\n\n> \*\*Open question:\*\* At \[00:15:16\], no date was stated\./);
});

test('keeps adjacent archived callouts as separate rendered blocks with their own classes', () => {
  const archive = {
    paragraphs: [
      {
        text: 'title: "Mayor and City Council Meeting" date: "2026-11-14" video_id: "abcdefghijk"',
        namedStyleType: 'NORMAL_TEXT',
        isListItem: false
      },
      { text: 'Resident impact: At [00:15:16], the Council discussed the budget.', namedStyleType: 'NORMAL_TEXT', isListItem: false },
      { text: 'Open question: At [00:22:09], no implementation date was stated.', namedStyleType: 'NORMAL_TEXT', isListItem: false }
    ]
  };
  const archiveResult = minutesFromArchiveJson(JSON.stringify(archive), source);
  assert.equal(archiveResult.ok, true);
  assert.match(archiveResult.minutesText, /\n\n> \*\*Open question:/);

  const validation = validateSummary(source, archiveResult.minutesText);
  assert.equal(validation.ok, true);
  const html = renderMarkdown(validation.payload.markdown, 'abcdefghijk');
  assert.equal((html.match(/<blockquote\b/g) ?? []).length, 2);
  assert.match(html, /<blockquote class="callout-resident-impact">/);
  assert.match(html, /<blockquote class="callout-open-question">/);
});

test('CLI writes the compact dispatch and canonical file only after source validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'laurel-summary-validation-'));
  try {
    const sourcePath = path.join(directory, 'source.txt');
    const minutesPath = path.join(directory, 'minutes.md');
    const dispatchPath = path.join(directory, 'dispatch.json');
    const outputPath = path.join(directory, 'canonical.md');
    const scriptPath = path.resolve('scripts/validate-summary.js');
    await writeFile(sourcePath, source);
    await writeFile(minutesPath, minutes);

    const good = spawnSync(process.execPath, [scriptPath, '--source', sourcePath, '--minutes', minutesPath,
      '--dispatch', dispatchPath, '--output', outputPath], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    const success = JSON.parse(good.stdout);
    assert.equal(success.ok, true);
    assert.equal(success.video_id, 'abcdefghijk');
    assert.deepEqual(JSON.parse(await readFile(dispatchPath, 'utf8')), {
      event_type: 'publish-minutes',
      client_payload: {
        title: 'Mayor and City Council Meeting',
        date: '2026-11-14',
        video_id: 'abcdefghijk',
        markdown: validateSummary(source, minutes).payload.markdown
      }
    });
    assert.match(await readFile(outputPath, 'utf8'), /video_url:/);

    await writeFile(minutesPath, minutes.replace('[00:15:16]', '[00:15:17]'));
    await rm(dispatchPath);
    const bad = spawnSync(process.execPath, [scriptPath, '--source', sourcePath, '--minutes', minutesPath,
      '--dispatch', dispatchPath], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout), {
      ok: false,
      reason: 'timestamp_not_in_source',
      invalid_timestamps: ['00:15:17']
    });
    assert.equal(bad.stdout.includes('[00:15:17]'), false);
    await assert.rejects(readFile(dispatchPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
