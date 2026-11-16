import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAddedMeetings } from '../scripts/check-branch-meetings.js';
import { serializeMeeting, meetingPath } from '../scripts/minutes.js';

const meeting = { title: 'City Council Meeting 11/23/26', date: '2026-11-23', video_id: 'abcdefghijk', markdown: '## At a glance\n\n- Item.\n' };
const file = meetingPath(meeting);
const contents = new Map([[file, serializeMeeting(meeting)]]);

test('accepts a branch that only adds a new, well-formed meeting file', () => {
  assert.deepEqual(checkAddedMeetings([{ status: 'A', file }], [], contents), [file]);
});

test('rejects a branch that changes anything other than new meeting files', () => {
  assert.throws(() => checkAddedMeetings([{ status: 'A', file }, { status: 'M', file: 'scripts/minutes.js' }], [], contents), /only add meeting files/);
  assert.throws(() => checkAddedMeetings([{ status: 'M', file }], [], contents), /only add meeting files/);
  assert.throws(() => checkAddedMeetings([], [], contents), /no changes/);
});

test('rejects a second entry for an already published video', () => {
  assert.throws(() => checkAddedMeetings([{ status: 'A', file }], ['src/content/meetings/2026-11-01-other-abcdefghijk.md'], contents), /already published/);
});

test('rejects a file whose name does not match its metadata', () => {
  const wrong = 'src/content/meetings/2026-11-23-wrong-name-abcdefghijk.md';
  assert.throws(() => checkAddedMeetings([{ status: 'A', file: wrong }], [], new Map([[wrong, contents.get(file)]])), /does not match/);
});
