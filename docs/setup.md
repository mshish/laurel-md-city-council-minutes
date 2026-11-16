# Setup and activation

## 1. Apps Script collector

Use Google's official [clasp CLI workflow](https://developers.google.com/apps-script/guides/clasp). Never commit clasp login credentials. The local `.clasp.json` binding is ignored too.

If a project has already been created for this checkout, reuse it rather than creating another:

```sh
clasp show-authorized-user
clasp list-scripts --noShorten
clasp create-script --title "Laurel Council Transcript Collector" --rootDir apps-script
clasp push
```

`create-script` is a one-time command; it may write a default manifest. Preserve the repository's reviewed `apps-script/appsscript.json` before pushing. Check `clasp status` to ensure tests, documentation and credentials are excluded.

Create a private Drive folder for incoming transcripts and a separate folder for archive Docs. Set the collector's `DESTINATION_FOLDER_ID` script property in Apps Script Project Settings. Review `apps-script/README.md` for optional properties. Never share the transcript folder publicly.

The manifest enables the advanced YouTube v3 service. When a standard Google Cloud project is attached, [enable the corresponding YouTube Data API there too](https://developers.google.com/apps-script/guides/services/advanced). For a default Apps Script Cloud project, enabling the advanced service enables the API automatically.

In the Apps Script editor:

1. Run `diagnoseConfig`, complete Google's authorization flow, and verify folder/channel access.
2. Run `runDailyPoll` once. Confirm a real, completed council meeting produces a readable timestamped transcript file. No transcript body should appear in execution logs.
3. Run it again and verify no duplicate file is created.
4. Confirm unavailable captions remain pending for a later run.
5. Only after the Studio input flow is ready, run `installDailyTrigger` for the morning schedule.

Apps Script can schedule within the selected hour; this is a next-day process, not an exact-time guarantee. `clasp push` only uploads code; it does not authorize services, execute functions or create a time trigger.

## 2. Workspace Studio

Create the flow using the owner's verified actions:

1. **When an item is added to a folder**: select the private incoming-transcripts folder. Filter for collector text files if the UI offers conditions.
2. **Ask Gemini**: use [the prompt](gemini-prompt.md), Text response, and the triggering file as the specific source. Disable unrelated sources/web search. Verify Studio reads the full text rather than only the filename or Drive URL. If the available action cannot read the file, stop and resolve that integration; do not produce minutes from metadata alone.
3. Gate subsequent actions on a valid result, excluding the exact sentinel `SOURCE_NOT_READY`.
4. **Create Google Doc**: archive the Markdown response in the separate archive folder. Do not save generated Docs in the input folder, which could recursively trigger the flow.
5. Configure the direct publishing webhook only after the authentication and escaping checks below pass.

Test with a representative full meeting transcript, not only a short snippet. Confirm dates, motions, votes, and copied timestamps against the actual text. No model input/output token limit is inferred from a consumer Gemini subscription's advertised context size.

## 3. Direct GitHub dispatch

Endpoint:

```text
POST https://api.github.com/repos/mshish/laurel-md-city-council-minutes/dispatches
```

Required headers:

```text
Accept: application/vnd.github+json
Authorization: Bearer <repository-scoped credential>
Content-Type: application/json
X-GitHub-Api-Version: 2026-03-10
```

Use a dedicated fine-grained personal access token restricted to this one repository with Contents: write, or a repository-scoped GitHub App. Do not reuse or display the local GitHub CLI token. Create/store the credential through the provider's supported secret mechanism; never include it in Markdown, the webhook URL, or Git commits.

The payload contract has four fields:

```json
{
  "event_type": "publish-minutes",
  "client_payload": {
    "title": "<exact source title>",
    "date": "<YYYY-MM-DD from source metadata>",
    "video_id": "<11-character source ID>",
    "markdown": "<complete Gemini Markdown response>"
  }
}
```

This is a contract illustration, not a safe literal Studio template. The entire object must be serialized as JSON: Markdown contains newlines, quotes and backslashes. Plain variable interpolation inside quotes is insufficient. GitHub limits the JSON payload to less than 64 KB and at most ten top-level `client_payload` properties. Send only summaries and metadata.

**Verified integration decision:** The actual personal Studio webhook form has no custom-header field. Direct dispatch cannot authenticate through that form. Use [the custom Apps Script step](../studio-publisher/README.md), which serializes JSON and sends authenticated HTTP. Its manifest and test-deployment installation have been verified, and it appears in the personal account's action list. First-use consent, a dedicated GitHub credential, and a successful live dispatch are still required. This repository does not add an unauthenticated relay or put credentials in a URL.

After the publishing workflow is present on `main`, test the dispatch using real source-grounded minutes. Expect HTTP 204, a successful Actions run, one new Markdown file, and a successful subsequent site build. A repeat of the identical payload must not create another meeting. Inspect the workflow's handling of publication bursts before enabling multiple simultaneous Studio runs.

## 4. Cloudflare Pages

Follow [Cloudflare's Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/) and connect `mshish/laurel-md-city-council-minutes`:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | Repository root |
| Node version | 22 or newer |

Use the free Pages plan and the requested project name `laurel-md-council-minutes`, yielding `laurel-md-council-minutes.pages.dev` if available. There are no Pages Functions or model API secrets. Git integration is intentional; do not substitute Direct Upload, which changes the hosting workflow. Review current [free-plan build limits](https://developers.cloudflare.com/pages/platform/limits/) before a historical backfill.

Verify the actual deployed URL and a real meeting page, including timestamp/source links, on desktop and mobile. A local build or green GitHub workflow alone is not a hosting or end-to-end test.
