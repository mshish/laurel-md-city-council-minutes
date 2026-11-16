# Laurel City Council Minutes

Transcript-only automation for unofficial summaries of City of Laurel, Maryland Mayor and City Council meetings and work sessions.

Apps Script → private Drive transcripts → Workspace Studio Ask Gemini + Google Docs archive → GitHub dispatch → Cloudflare Pages.

No video/audio downloads, paid Gemini API calls, or Claude processing are part of this implementation. The public site and repository contain summaries, not raw transcripts.

## Develop

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run build
```

The static build is written to `dist/`. There are no sample meetings masquerading as real minutes.

## Configure

- [Architecture, limitations, and official references](docs/architecture.md)
- [Setup and activation checklist](docs/setup.md)
- [Gemini prompt](docs/gemini-prompt.md)
- [Transcript collector](apps-script/)

Workspace Studio access and the proposed actions have been verified by the owner. Live collection, authenticated dispatch, and hosting each need an integration test before the automation can be called operational.
