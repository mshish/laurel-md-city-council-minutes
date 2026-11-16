import { readFile, mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { validatePayload, serializeMeeting } from './minutes.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function persistPayload(payload, root = projectRoot) {
  const { file: suppliedPath, ...input } = payload;
  if (typeof input.markdown !== 'string') throw new Error('markdown must be a string');
  const sourceMarkdown = `---\n${stringify({ title: input.title, date: input.date, video_id: input.video_id })}---\n\n${input.markdown}`;
  const validated = validatePayload({ ...input, markdown: sourceMarkdown });
  const relative = validated.file;
  if (suppliedPath !== relative) throw new Error('Supplied file path does not match validated metadata');
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relative);
  const meetingsDir = path.resolve(absoluteRoot, 'src', 'content', 'meetings');
  if (!absolute.startsWith(`${meetingsDir}${path.sep}`)) throw new Error('Resolved path escaped the meetings directory');

  await mkdir(meetingsDir, { recursive: true });
  const realRoot = await realpath(absoluteRoot);
  const realMeetings = await realpath(meetingsDir);
  if (!realMeetings.startsWith(`${realRoot}${path.sep}`)) throw new Error('Meetings directory resolves outside the repository');

  const content = serializeMeeting(validated);
  try {
    await writeFile(absolute, content, { flag: 'wx' });
    return { created: true, file: relative };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existingInfo = await lstat(absolute);
    if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular file at ${relative}`);
    }
    const existing = await readFile(absolute, 'utf8');
    if (existing !== content) throw new Error(`Refusing to replace existing minutes at ${relative}`);
    return { created: false, file: relative };
  }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH must point to the GitHub event JSON file');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (!event || typeof event !== 'object' || event.action !== 'publish-minutes') {
    throw new Error('Expected a publish-minutes repository_dispatch event');
  }
  const payload = validatePayload(event.client_payload);
  const result = await persistPayload(payload);
  process.stdout.write(result.created ? `Created ${result.file}\n` : `Already published ${result.file}; no changes made.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`publish-minutes rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
