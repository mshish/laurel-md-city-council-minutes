// Gate for summaries pushed by the scheduled Claude routine on a claude/minutes-* branch.
// A branch qualifies for promotion to main only if it adds new meeting files and
// changes nothing else. Prints the added paths, one per line, for the workflow.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseMeeting, meetingPath } from './minutes.js';

const MEETING_FILE = /^src\/content\/meetings\/[^/]+\.md$/;

// changes: [{ status, file }]; mainFiles: paths already on main; contents: Map(path -> text).
export function checkAddedMeetings(changes, mainFiles, contents) {
  if (!changes.length) throw new Error('branch has no changes against main');
  const seen = new Set();
  for (const { status, file } of changes) {
    if (status !== 'A' || !MEETING_FILE.test(file)) {
      throw new Error(`branch may only add meeting files; found ${status} ${file}`);
    }
    const meeting = parseMeeting(contents.get(file), file);
    if (meetingPath(meeting) !== file) throw new Error(`${file} does not match its title, date, and video_id`);
    const suffix = `-${meeting.video_id}.md`;
    if (seen.has(meeting.video_id) || mainFiles.some((existing) => existing.endsWith(suffix))) {
      throw new Error(`video ${meeting.video_id} is already published or added twice`);
    }
    seen.add(meeting.video_id);
  }
  return changes.map((change) => change.file);
}

async function main() {
  const base = process.argv[2];
  if (!base) throw new Error('usage: check-branch-meetings.js <base-ref>');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const changes = git('diff', '--name-status', '--no-renames', `${base}...HEAD`).split('\n').filter(Boolean)
    .map((line) => { const [status, file] = line.split('\t'); return { status, file }; });
  const mainFiles = git('ls-tree', '--name-only', base, 'src/content/meetings/').split('\n').filter(Boolean);
  const contents = new Map();
  for (const { status, file } of changes) if (status === 'A') contents.set(file, await readFile(path.resolve(file), 'utf8'));
  process.stdout.write(`${checkAddedMeetings(changes, mainFiles, contents).join('\n')}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`promotion rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
