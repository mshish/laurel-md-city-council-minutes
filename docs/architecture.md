# Architecture and verified limitations

The goal is next-morning, transcript-only unofficial summaries using existing ChatGPT and Workspace Studio access, with no paid model API calls.

1. Windows Task Scheduler invokes `automation/run-daily.ps1` daily at 7 AM Eastern. It runs the installed Codex CLI's documented noninteractive `codex exec` command using the existing user configuration. `-p` means profile, not prompt.
2. A deterministic Python helper discovers recent completed council meetings from the official Laurel TV channel. It selects titles and verifies the meeting date, then obtains captions with youtube-transcript-api. No media is downloaded. The default lookback is 45 days, with at most three unpublished candidates handled per run.
3. Codex uploads local transcript files through the existing Google Drive connector without reading their bodies. Workspace Studio's folder starter invokes Ask Gemini with the triggering file link and saves a Google Doc in the separate archive folder. Web search is disabled.
4. Codex reads only the generated archive Doc. `scripts/validate-summary.js` reads the local source privately and checks exact metadata, every timestamp, allowed links, and payload size. An unsupported timestamp blocks that summary; the agent must not repair it.
5. Accepted summaries go through authenticated `gh api` to `repository_dispatch`. GitHub Actions validates and commits one Markdown file per video. Cloudflare Pages Git integration builds from `main`.

## Verified integration evidence

On November 16, 2026, a real November 9 council transcript automatically produced an archive Doc, passed source validation, completed the publishing workflow, and appeared on the public Pages site. Another generated summary contained a timestamp absent from its source and was correctly rejected. Timestamp validation does not prove every statement in a summary; these remain clearly labeled unofficial AI-generated summaries.

Apps Script's YouTube metadata access works, but its anonymous ANDROID InnerTube caption request returned `LOGIN_REQUIRED` with no tracks for completed public recordings. No Apps Script polling trigger is enabled. The local collector is the selected source path, as authorized by the owner.

The personal Studio webhook UI has no custom-header field, so it cannot directly authenticate to GitHub. An optional custom Apps Script publishing step was installed and authorized during exploration, but the active Studio flow has only the folder starter, Ask Gemini, and Create a Doc. No publisher PAT is configured; the scheduled CLI uses the existing GitHub login.

The schedule depends on this Windows user being signed in, the computer being available, and existing connector/CLI sessions remaining valid. Unavailable captions and pending Docs are retried later without duplicate uploads. Private `.local` logs may contain generated summaries, but must never contain raw transcript bodies.

## Primary references

- [Codex noninteractive mode](https://developers.openai.com/codex/noninteractive/)
- [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Studio starters and steps](https://support.google.com/workspace-studio/table/17176961)
- [Create repository dispatch event](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
