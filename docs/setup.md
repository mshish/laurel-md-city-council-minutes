# Setup

## Local scheduled workflow

Follow [the scheduled-run guide](scheduled-run.md). Use the existing Codex ChatGPT login, Google Drive connector, and authenticated `gh` CLI. No model API key, separate Drive OAuth application, or publisher PAT is needed.

Install Python dependencies from `local-collector/requirements.txt` into a private virtual environment. Use official Node.js 22 or newer for the validator and site. Configure runtime paths, the repository, private incoming/archive folder IDs, and readiness flags in ignored `.local/setup-state.json`. Never commit login files or transcripts.

Register the task only after testing collection, connector upload, Studio output, source validation, GitHub publication, and the deployed page. The registration script creates `LaurelCouncilMinutes-Daily` at 7 AM Eastern under the current interactive user and refuses to replace an existing task.

## Workspace Studio

The active flow has three steps:

1. **When an item is added to a folder**: select the private incoming-transcripts folder.
2. **Ask Gemini**: use [the prompt](gemini-prompt.md) with the starter's dynamic file-link variable. Enable Workspace sources and web search; the prompt limits external lookup to official Laurel directories for name spelling and roles, never meeting facts. Verify it reads a representative full transcript.
3. **Create a Doc**: name it `Laurel Council Minutes — <starter item name>`, use Gemini's generated content, and select the separate private archive folder.

Keep archive Docs outside the input folder to prevent recursive triggering. Enable the flow before setting `studio_flow_enabled` true. The scheduled run fetches generated Docs only and validates them against the local source before publication. `SOURCE_NOT_READY`, metadata mismatches, and unsupported timestamps must remain blocked.

The direct Studio webhook has no authorization-header field. Leave publishing to the scheduled GitHub CLI. The optional `apps-script/` collector and `studio-publisher/` custom action are preserved for reference; neither is required or scheduled in the active pipeline.

## Cloudflare Pages

Use [Cloudflare's Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/) with `mshish/laurel-md-city-council-minutes`:

| Setting | Value |
| --- | --- |
| Project | `laurel-md-council-minutes` |
| Production branch | `main` |
| Framework | None |
| Build command | `npm run build` |
| Output | `dist` |
| Root | Repository root |
| Node version | 22 |

The live address is https://laurel-md-council-minutes.pages.dev. No custom domain or Pages Functions are needed. Verify a real deployed meeting page after publication; a successful dispatch response alone is insufficient.
