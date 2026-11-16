# Stage 1: Google Apps Script transcript collector

This project checks LaurelTVOfficial's YouTube uploads once per day, identifies
City Council meetings and work sessions, waits for a completed live stream, and
writes caption text with `[HH:MM:SS]` timestamps to one UTF-8 `.txt` file in a
configured Drive folder. The file begins with YAML metadata for `title`,
`date`, `video_id`, `date_source`, and `date_verified`, followed by transcript
lines only. A date in the title is preferred. If the title has no parseable
date, the actual stream start is recorded in America/New_York as
`date_source: "actual_stream_start"` and `date_verified: "false"`; if no start
time exists, the date is `unknown` and unverified. This allows downstream
Studio instructions to stop before generating minutes when the meeting date is
not established. Upload date is never used as a meeting date. The script reads
metadata and captions only. It does not fetch video or audio.

Two-digit dates such as `10/7/26` are accepted only when the final two digits
match the year of `actualStartTime` in America/New_York. A mismatch or missing
stream start leaves the title date unverified; the parser does not guess a
century.

## Setup

1. Create a standalone Apps Script project and copy `Code.gs` and
   `appsscript.json` into it. The YouTube Data API v3 advanced service is
   declared in the manifest; enable that API in the project's linked Google
   Cloud project as well.
2. In **Project Settings > Script properties**, set:
   - `DESTINATION_FOLDER_ID` to the Drive folder ID for transcripts.
   - Optionally `CHANNEL_HANDLE` (defaults to `@LaurelTVOfficial`).
   - Optionally `LOOKBACK_DAYS` (defaults to 45 and is capped at 120).
3. Run `diagnoseConfig()` in the Apps Script editor and authorize the requested
   scopes. The diagnostic checks the destination folder and channel and reports
   only small metadata; it does not fetch or print captions.
4. Run `installDailyTrigger()` once to install one daily trigger around 7 AM
   America/New_York. Apps Script may choose a minute within the hour. This
   helper is idempotent and is intentionally not invoked automatically.

To investigate caption access without exporting files, run
`diagnoseCaptionAccess()`. It probes at most three pending target videos (or
recent matches if the queue is empty) and reports only IDs/titles, stream end
metadata, HTTP codes, allowlisted playability status, caption track counts, and
response/event/line counts. It does not modify the pending queue or log caption
text, response bodies, arbitrary server messages, or caption URLs.

If using clasp, copy `.clasp.example.json` to `.clasp.json`, put the project ID
in that local file, and keep it out of version control. No OAuth tokens or
credentials belong in this repository.

## Selection, retries, and duplicate protection

The scan examines at most the newest 50 uploads, then admits only videos inside
the lookback window whose **title** includes `Mayor and City Council` (or
`Mayor & City Council`) and a meeting/work-session phrase. Descriptions do not
affect selection, which avoids unrelated programming that happens to mention a
council meeting. Videos must have `liveStreamingDetails.actualEndTime`
and must not be marked live or upcoming. A small Script Properties queue keeps
eligible videos whose captions have not appeared yet; those are retried on
subsequent daily runs for up to 180 days. Each pending item is stored as its own
Script Property to keep values small and independently retryable. A successful file name includes the
YouTube video ID. That Drive file is the idempotency record, so a pending entry
is cleared only after the transcript file is created or found.

The daily run processes at most 12 videos and stops its work after four
minutes. A script lock prevents overlapping runs. A transient per-video failure
keeps the candidate queued for a later run. Logs contain counts/status only,
never transcript text, caption URLs, or Script Properties values. Caption JSON3
events are emitted in source order. The collector does not attempt semantic
deduplication of repeated rolling-caption fragments, so repeated words in
YouTube's returned captions may remain in the transcript.

## Caption protocol limitation

The official YouTube Data API metadata path uses the Apps Script YouTube
advanced service. Public-video caption text is fetched through YouTube's
undocumented Android Innertube player endpoint and its `fmt=json3` caption URL.
This private adapter may stop working when YouTube changes the protocol; the
candidate remains queued for a later retry. The code keeps that dependency in
`fetchTranscript_()` and `CAPTION_ADAPTER`. There is no fallback that downloads
media or silently substitutes another caption source.

### Live access check

On November 15, 2026, `diagnoseCaptionAccess()` checked three completed Laurel
TV recordings, including titles dated `10/7/26`, `10/14/26`, and `10/26/26`.
All three Android player requests returned HTTP 200 with
`playability_status: LOGIN_REQUIRED` and zero English caption tracks, so no
timed-text request could be made. Separately, local `youtube-transcript-api`
1.2.5 fetched 1,812 caption segments for video `RBey6C45RNs`. That single-video
result is evidence for that recording only; it does not establish that the
local adapter works for other videos or the channel generally. The Apps Script
caption path is therefore not currently verified for these recordings.

## Local tests

Run `npm test` in this directory with Node.js. The tests exercise selection,
JSON3 timestamp formatting, caption retry, and Drive-based idempotency using
local Apps Script service mocks. They do not authenticate to Google or YouTube.
