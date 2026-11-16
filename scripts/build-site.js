import { readFile, readdir, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeeting, renderMarkdownWithToc } from './minutes.js';

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
  <meta name="theme-color" content="#1463f3">
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
  <footer class="site-footer"><div class="shell"><p>Unofficial AI summary. May contain mistakes; verify against the recording.</p></div></footer>
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

export function renderMeetingPage(meeting) {
  const { html } = renderMarkdownWithToc(meeting.markdown, meeting.video_id, meeting.title);
  const fileName = path.basename(meeting.file, '.md');
  return page({
    title: meeting.title,
    description: `Unofficial AI-generated summary of the Laurel City Council meeting on ${meeting.date}.`,
    canonicalPath: `/meetings/${encodeURIComponent(fileName)}/`,
    content: `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">All meetings</a><span aria-hidden="true">/</span><span>${escapeHtml(meeting.date)}</span></nav>
<article class="minutes">
  <header class="minutes-header"><p class="eyebrow">Laurel City Council · <time datetime="${escapeHtml(meeting.date)}">${escapeHtml(meeting.date)}</time></p><h1>${escapeHtml(meeting.title)}</h1><p class="source-link"><a href="${escapeHtml(meeting.video_url)}" rel="noopener noreferrer" target="_blank">Open the source recording on YouTube <span aria-hidden="true">↗</span></a></p></header>
  <div class="prose">${html}</div>
</article>`,
  });
}

export async function buildSite() {
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
  <p class="hero-copy">Browse concise summaries by meeting date and follow each one back to its source recording.</p>
</section>
<section class="archive" aria-labelledby="archive-title">
  <div class="section-heading"><div><p class="eyebrow">The archive</p><h2 id="archive-title">Recent meetings</h2></div><p class="count">${meetings.length} ${meetings.length === 1 ? 'summary' : 'summaries'}</p></div>
  ${list}
  </section>`,
  });
  await writeFile(path.join(outputDir, 'index.html'), home);

  for (const meeting of meetings) {
    const fileName = path.basename(meeting.file, '.md');
    const output = path.join(outputDir, 'meetings', fileName, 'index.html');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, renderMeetingPage(meeting));
  }
  process.stdout.write(`Built ${meetings.length} meeting page${meetings.length === 1 ? '' : 's'} in dist/.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSite().catch((error) => {
    process.stderr.write(`site build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
