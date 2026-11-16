# Architecture and integration gates

The goal is next-morning, transcript-only unofficial summaries, with no Gemini API billing and no Claude scheduled processing. Google Workspace Studio Ask Gemini uses the user's existing access; no model API key is required by this repository.

1. Google Apps Script polls the official Laurel TV uploads playlist using the advanced YouTube service. It selects council meetings/work sessions, confirms the livestream has ended, and saves timestamped caption text and metadata in a private Drive input folder.
2. Studio's **When an item is added to a folder** starter reads the new transcript. **Ask Gemini** uses `gemini-prompt.md`. **Create Google Doc** archives the result in a different folder.
3. Studio sends the summarized Markdown and metadata to GitHub's `repository_dispatch` endpoint, event type `publish-minutes`. Raw transcripts never enter the event or this repository.
4. GitHub Actions validates and commits one Markdown file per source video. Cloudflare Pages Git integration builds the static site from `main`.

## Evidence boundaries

- The user has verified Studio access and the listed actions. This does not by itself verify field-level behavior such as authenticated headers, JSON escaping, or `.txt` source reading.
- The actual personal Studio webhook form was inspected on November 15, 2026: it has URL, method and plain-text payload, with no Authorization-header field. GitHub requires authenticated requests, so the direct integration cannot work through that form. Do not put a GitHub token in the URL, commit it, or reuse the local CLI's broad token in Studio.
- The owner authorized exploring a publishing fallback, including a scheduled ChatGPT task. `studio-publisher/` implements Google's documented custom Apps Script step, which serializes JSON and sets headers without model usage. Its manifest was accepted by Apps Script, its private test deployment installed, and the custom action appeared in the personal Studio account on November 15, 2026. First-use OAuth consent, a dedicated repository-scoped credential, and live dispatch validation are still required. No unauthenticated public relay is substituted; no ChatGPT scheduled task is needed for this route.
- Google does not provide a supported caption-download API for arbitrary third-party channels. The ANDROID InnerTube adapter is the explicitly requested exception and may fail even when a public transcript exists. Test it from Apps Script's actual egress before declaring Stage 1 operational; a local test cannot prove that.
- Gemini subscription context-window claims do not establish the Studio step's practical file/input limits. Test a representative full council transcript. A successful short sample is insufficient.
- Source upload dates can differ from meeting dates. Do not publish a date inferred only from upload time; ambiguous dates need review.
- The initial site contains no fabricated meeting minutes. An empty archive is expected until a real transcript has completed the flow.

## Official references

- [Apps Script CLI](https://developers.google.com/apps-script/guides/clasp)
- [Advanced Google services](https://developers.google.com/apps-script/guides/services/advanced)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [YouTube channels.list and forHandle](https://developers.google.com/youtube/v3/docs/channels/list)
- [YouTube playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list)
- [YouTube videos resource and livestream details](https://developers.google.com/youtube/v3/docs/videos)
- [Caption-download authorization](https://developers.google.com/youtube/v3/docs/captions/download)
- [Studio starters and steps](https://support.google.com/workspace-studio/table/17176961)
- [Studio webhook configuration](https://support.google.com/workspace-studio/answer/16521900)
- [Create repository dispatch event](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
