# Architecture and verified limitations

The goal is next-morning, transcript-only unofficial summaries using existing ChatGPT and Workspace Studio access, with no paid model API calls.

1. Windows Task Scheduler invokes `automation/run-daily.ps1` daily at 7 AM Eastern. It runs the installed Codex CLI's documented noninteractive `codex exec` command using the existing user configuration. `-p` means profile, not prompt.
2. A deterministic Python helper discovers recent completed council meetings from the official Laurel TV channel. It selects titles and verifies the meeting date, then obtains captions with youtube-transcript-api. No media is downloaded. The default lookback is 45 days, with at most three unpublished candidates handled per run.
3. Codex uploads local transcript files through the existing Google Drive connector without reading their bodies. Workspace Studio's folder starter invokes Ask Gemini with the triggering file link and saves a Google Doc in the separate archive folder. Web search is enabled only for official Laurel name and role verification under the prompt; the transcript remains the evidence for meeting events.
4. Codex reads only the generated archive Doc. `scripts/validate-summary.js` reads the local source privately and checks exact metadata, every timestamp, allowed links, and payload size. An unsupported timestamp blocks that summary; the agent must not repair it.
5. Accepted summaries go through authenticated `gh api` to `repository_dispatch`. GitHub Actions validates and commits one Markdown file per video. Cloudflare Pages Git integration builds from `main`.

## Current summarizer: scheduled Claude routine

Steps 3–5 currently run in a Claude Code cloud routine instead of Workspace Studio, selected by `studio_flow_enabled: false` in `.local/setup-state.json`. The local run still collects captions and uploads transcripts, because YouTube refuses caption requests from cloud servers (see the Apps Script finding below). At 8:30 AM Eastern the routine reads new transcripts from the Drive folder through the Google Drive connector, writes the summary under the same contract in `docs/gemini-prompt.md`, runs the same source validator against a byte-checked copy of the transcript, and pushes the meeting file on a `claude/minutes-<video_id>` branch. The `Promote routine minutes` workflow checks that the branch only adds new well-formed meeting files and commits them to `main`. The full procedure is in `docs/claude-summary-prompt.md`. Unlike the Studio path, the summarizing agent reads the transcript; transcripts still never enter the repository.

To switch back to Gemini, re-enable the Studio flow, set `studio_flow_enabled` to true, and pause the routine at claude.ai/code/routines.

## Verified integration evidence

On November 16, 2026, a real November 9 council transcript automatically produced an archive Doc, passed source validation, completed the publishing workflow, and appeared on the public Pages site. A subsequent real Task Scheduler run discovered six recent meetings, skipped the published video, collected and uploaded two new transcripts, and retrieved their Studio archive Docs. All three selected summaries (including an older archive) contained unsupported timestamps and were held; it submitted no dispatches. The task completed with exit code zero because the workflow ran correctly, so inspect its private result/status files for publication and validation outcomes. Timestamp validation does not prove every statement in a summary; these remain clearly labeled unofficial AI-generated summaries.

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

## Presentation and editorial contract

The renderer owns color, layout, navigation, timestamp links, and callout styling. Gemini emits structured Markdown, not HTML or CSS. Callouts identify transcript-supported facts, practical resident implications, and open questions without assigning motives or declaring procedural violations. Official city directories may resolve name spelling and roles; they do not establish attendance or who spoke. Unverified names use the brief [name uncertain] marker. One compact site footer provides the AI notice; specific transcript limitations remain factual content.

On November 16, the revised citizen-focused prompt was tested in the live Studio flow. Providing a dated official spelling reference improved name resolution, and the explicit tied-vote example prevented an inferred parliamentary outcome. The final test still contained one unsupported timestamp and was held by the source validator; no new meeting was dispatched from that test. Formatting is deterministic, but generation still requires these evidence checks.

The meeting page is a single reading column ordered by what a resident needs first: At a glance and the Worth a closer look callouts, then section links, decisions, agenda items, public comment and action items, with meeting information, transcript limitations and the name note collected at the end. Each decision shows its title, the explicitly recorded result as a colored label, the motion, and the vote and mover details. The result color comes only from the result wording, never from vote counts. Agenda items show the summary text in full, split into one bullet per sentence, with a kind label read from the item title (spending, ordinance, resolution, public comment, reports) and the recorded result of any decision whose first timestamp starts that item. Dollar amounts are highlighted. The renderer regroups and relabels source text but never shortens or rewrites it. Callouts connect to agenda items only through an exact topic field or an unambiguous recorded timestamp range, and a linked agenda item links back to its callout.

The forward Markdown contract uses own-paragraph headings beginning Agenda item:, Decision:, and Comment topic:. These prefixes preserve structure when the Workspace Studio Google Doc archive returns heading text as normal paragraphs. Callouts use a literal pipe-delimited Topic field for exact matching. This is a presentation contract; the source metadata and timestamp validation requirements remain unchanged.
