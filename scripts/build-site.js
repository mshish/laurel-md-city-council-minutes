import { readFile, readdir, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeeting, renderMarkdown } from './minutes.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(projectRoot, 'src', 'content', 'meetings');
const outputDir = path.join(projectRoot, 'dist');
const CSS_PATH = '/assets/style.css';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function page({ title, description, content, canonicalPath = '/' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#173b35">
  <title>${escapeHtml(title)} · Laurel Council Minutes</title>
  <link rel="canonical" href="${canonicalPath}">
  <link rel="stylesheet" href="${CSS_PATH}">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="shell header-inner">
      <a class="brand" href="/" aria-label="Laurel Council Minutes home">
        <span class="brand-mark" aria-hidden="true">LC</span>
        <span>Laurel Council Minutes</span>
      </a>
      <span class="header-note">Public meeting summaries</span>
    </div>
  </header>
  <main id="main" class="shell">${content}</main>
  <footer class="site-footer"><div class="shell"><p>Unofficial AI-generated summaries. The linked meeting recording is the authoritative source.</p></div></footer>
</body>
</html>
`;
}

async function readMeetings() {
  let entries;
  try {
    entries = await readdir(contentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const meetings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(contentDir, entry.name);
    meetings.push(parseMeeting(await readFile(file, 'utf8'), entry.name));
  }
  return meetings.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}

async function main() {
  const meetings = await readMeetings();
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.join(outputDir, 'assets'), { recursive: true });
  await copyFile(path.join(projectRoot, 'src', 'static', 'style.css'), path.join(outputDir, 'assets', 'style.css'));

  const list = meetings.length
    ? `<ol class="meeting-list">${meetings.map((meeting) => {
      const fileName = path.basename(meeting.file, '.md');
      return `<li class="meeting-card">
  <p class="eyebrow"><time datetime="${escapeHtml(meeting.date)}">${escapeHtml(meeting.date)}</time></p>
  <h2><a href="/meetings/${encodeURIComponent(fileName)}/">${escapeHtml(meeting.title)}</a></h2>
  <p class="card-link"><a href="${escapeHtml(meeting.video_url)}" rel="noopener noreferrer" target="_blank">Open source recording <span aria-hidden="true">↗</span></a></p>
</li>`;
    }).join('\n')}</ol>`
    : '<div class="empty-state"><h2>No meeting summaries yet</h2><p>Published meeting summaries will appear here when available.</p></div>';
  const home = page({
    title: 'Home',
    description: 'Unofficial AI-generated summaries of Laurel, Maryland City Council meetings, with links to the source recordings.',
    content: `<section class="hero" aria-labelledby="page-title">
  <p class="eyebrow">Laurel, Maryland</p>
  <h1 id="page-title">City Council meeting summaries</h1>
  <p class="hero-copy">Browse concise, searchable-by-date summaries of council meetings and follow every summary back to its recording.</p>
</section>
<section class="archive" aria-labelledby="archive-title">
  <div class="section-heading"><div><p class="eyebrow">The archive</p><h2 id="archive-title">Recent meetings</h2></div><p class="count">${meetings.length} ${meetings.length === 1 ? 'summary' : 'summaries'}</p></div>
  ${list}
</section>
<aside class="notice" aria-label="Summary notice"><span class="notice-icon" aria-hidden="true">i</span><p><strong>Read with the recording.</strong> These are unofficial AI-generated summaries, provided as a convenience. They may omit or misstate details; use the linked video as the authoritative record.</p></aside>`,
  });
  await writeFile(path.join(outputDir, 'index.html'), home);

  for (const meeting of meetings) {
    const fileName = path.basename(meeting.file, '.md');
    const output = path.join(outputDir, 'meetings', fileName, 'index.html');
    await mkdir(path.dirname(output), { recursive: true });
    const content = page({
      title: meeting.title,
      description: `Unofficial AI-generated summary of the Laurel City Council meeting on ${meeting.date}.`,
      canonicalPath: `/meetings/${encodeURIComponent(fileName)}/`,
      content: `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">All meetings</a><span aria-hidden="true">/</span><span>${escapeHtml(meeting.date)}</span></nav>
<article class="minutes">
  <header class="minutes-header"><p class="eyebrow">Laurel City Council · <time datetime="${escapeHtml(meeting.date)}">${escapeHtml(meeting.date)}</time></p><h1>${escapeHtml(meeting.title)}</h1><p class="source-link"><a href="${escapeHtml(meeting.video_url)}" rel="noopener noreferrer" target="_blank">Open the source recording on YouTube <span aria-hidden="true">↗</span></a></p></header>
  <aside class="notice" aria-label="Summary notice"><span class="notice-icon" aria-hidden="true">i</span><p><strong>Unofficial AI-generated summary.</strong> This summary may omit or misstate details. Consult the <a href="${escapeHtml(meeting.video_url)}" rel="noopener noreferrer" target="_blank">meeting recording</a> for the authoritative source.</p></aside>
  <div class="prose">${renderMarkdown(meeting.markdown, meeting.video_id, meeting.title)}</div>
</article>`,
    });
    await writeFile(output, content);
  }
  process.stdout.write(`Built ${meetings.length} meeting page${meetings.length === 1 ? '' : 's'} in dist/.\n`);
}

main().catch((error) => {
  process.stderr.write(`site build failed: ${error.message}\n`);
  process.exitCode = 1;
});
