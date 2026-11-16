# Local transcript collection

This folder contains a local discovery and transcript-fetch fallback for Laurel City Council streams. `monitor.py` scans the newest 50 entries on `@LaurelTVOfficial/streams` with yt-dlp's Python extractor. It reads channel entries flat, then requests full metadata only for matching titles. Calls use `download=False` and `skip_download=True`; the collector never downloads video or audio.

The monitor accepts only titles that identify the Mayor and City Council plus a meeting or work session, whose yt-dlp metadata says the stream has ended, and whose title contains a real meeting date within the last 45 days in `America/New_York` (configurable from 1 to 120 days with `--lookback-days`). A two-digit title year such as `10/26/26` must match the year from the stream's actual `release_timestamp` or `start_time`, interpreted in Eastern time. It never substitutes the upload date. Candidates without enough evidence are omitted and can be reconsidered on a later scan.

The JSON manifest contains candidate metadata, scan counts, successful transcript metadata and local paths, and safe failure reason codes. It never contains transcript text. Standard output reports only counts and status. Network calls have finite timeouts and retry counts; output includes title-match and metadata-failure counts so an extractor failure cannot look like an empty channel. Failed transcript fetches do not enter the successful transcript list; the next scan retries them. Transcript files use `<video-id>.txt`, the same YAML frontmatter and `[HH:MM:SS]` timestamp lines as the Apps Script collector. Existing successful files are skipped by video ID.

## Windows setup

From the repository root:

```powershell
py -m venv .local\transcript-tools
.\.local\transcript-tools\Scripts\python.exe -m pip install -r .\local-collector\requirements.txt
```

Discover and write a metadata-only manifest:

```powershell
.\.local\transcript-tools\Scripts\python.exe .\local-collector\monitor.py --discover-only --manifest .local\transcripts\manifest.json
```

Override the 45-day default, for example:

```powershell
.\.local\transcript-tools\Scripts\python.exe .\local-collector\monitor.py --discover-only --lookback-days 30 --manifest .local\transcripts\manifest.json
```

Fetch transcript files for up to ten candidates:

```powershell
.\.local\transcript-tools\Scripts\python.exe .\local-collector\monitor.py --output-dir .local\transcripts --manifest .local\transcripts\manifest.json --max-transcripts 10
```

Limit collection to one explicitly selected video ID:

```powershell
.\.local\transcript-tools\Scripts\python.exe .\local-collector\monitor.py --video-id RBey6C45RNs --output-dir .local\transcripts --manifest .local\transcripts\manifest.json
```

`collector.py` remains available for directly fetching one identified video with a verified title/date, or replaying JSON offline. Its default output folder is `.local/transcripts` relative to the current working directory.

## Drive handoff and recurring runs

This program does not authenticate to or upload to Google Drive. The existing Google Drive connector is the scheduled agent's Drive interface; the agent can compare the manifest's candidate IDs with the private input folder and upload only new local `.txt` files through that connector. No new OAuth client, token, or Drive scope is needed here.

For a recurring Windows run, Task Scheduler requires the machine to be awake and online and the task to run in the logged-in user's session so Codex can use the existing signed-in account. Schedule the Codex job that runs discovery, compares Drive filenames, fetches only missing IDs, and uploads them; do not configure Windows Task Scheduler to start `monitor.py` alone if Drive deduplication and upload are part of the job. No scheduled task is installed by this folder.

## Tests

The standard-library offline tests use mocked yt-dlp metadata and temporary directories; they need no network or Drive connection:

```powershell
..\.local\transcript-tools\Scripts\python.exe -m unittest discover -s .\local-collector -v
```
