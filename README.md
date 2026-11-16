# Laurel City Council Minutes

Transcript-only automation for unofficial summaries of City of Laurel, Maryland Mayor and City Council meetings and work sessions.

Live archive: https://laurel-md-council-minutes.pages.dev

A daily local Codex CLI run discovers completed meetings, collects caption text, and uploads it through the connected Google Drive tools. Workspace Studio uses Ask Gemini to summarize the transcript and archives the result as a Google Doc. Codex runs a deterministic source validator and submits accepted summaries through the existing GitHub CLI login. GitHub Actions commits the minutes; Cloudflare Pages builds from `main`.

No video/audio downloads, paid Gemini API calls, separate Drive OAuth client, or publisher PAT are required. Raw transcripts stay in ignored local storage and private Drive; they never enter Codex's context or the public repository.

## Develop

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run build
```

The static build is written to `dist/`.

## Operations

- [Architecture and verified limitations](docs/architecture.md)
- [Setup](docs/setup.md)
- [Scheduled Codex run](docs/scheduled-run.md)
- [Gemini prompt](docs/gemini-prompt.md)
- [Local transcript collector](local-collector/)

The Windows task runs daily at 7 AM Eastern while the configured user is signed in. This computer must be available; missed runs start when available. Summaries with unsupported timestamps or mismatched metadata are held rather than published.
