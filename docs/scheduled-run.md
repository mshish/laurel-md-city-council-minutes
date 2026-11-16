# Scheduled local run

The Task Scheduler job runs the workflow as the signed-in Windows user at 7:00 AM Eastern. It uses the existing Codex CLI login and Google Drive connector. It does not add Drive OAuth or a publisher PAT. The run is local to this machine; it needs the user session, network access, and an awake machine. If the machine misses 7:00 AM, `StartWhenAvailable` allows Task Scheduler to run it later.

## Before the first run

1. Configure `.local/setup-state.json` locally. It is ignored by Git and must contain the repository, private transcript and archive folder IDs, readiness flags, plus absolute `python_path` and `node_path` values. Point these to the installed local-collector virtual environment and the official Node.js 22 executable under `.local/tools/node22`. Do not put credentials in the file.
2. Confirm `collector_configured`, `collector_authorized`, and `studio_flow_enabled` are all `true`. The Studio flow should be **When an item is added to the private transcript folder → Ask Gemini → Create Google Doc in the archive folder**. The separate publisher Apps Script and any publisher PAT are not used.
3. Install the local collector dependencies in its virtual environment. From the repository root:

   ```powershell
   py -m venv local-collector\.venv
   local-collector\.venv\Scripts\python.exe -m pip install -r local-collector\requirements.txt
   ```

   Set `python_path` in `.local/setup-state.json` to that exact executable. The scheduled workflow uses metadata-only discovery first, then collects no more than three newly selected candidates per run from the newest 45 days.
4. Confirm the existing Codex CLI login and Google Drive connector work in the signed-in user session, and that the existing GitHub CLI is authenticated for `mshish/laurel-md-city-council-minutes`. The prompt never creates or prints credentials.
5. Confirm Cloudflare Pages is connected to the repository if you expect the run to verify the public site after publication.

The local validator compares the generated Google Doc summary against the cached source transcript. The transcript text never enters the model context. If Studio has not made an archive Doc yet, or the validator rejects metadata/timestamps, that candidate remains pending; the workflow does not invent or repair minutes.

## Run once

From the repository root, use the installed native Codex CLI path and the current user's config/login:

```powershell
& .\automation\run-daily.ps1
```

The wrapper starts `codex exec --approve-for-me --json`, sends `automation\prompt.md` through standard input, and applies a 60-minute timeout. The automatic review path retains Codex's workspace-write sandbox; the wrapper does not use `--ask-for-approval never` or the dangerous sandbox bypass.

Run artifacts are kept under `.local\runs\<run-id>\`; cached transcript files are under `.local\transcripts\`. Both paths are ignored by Git and may contain private source or generated-summary material. The private Codex JSONL log can contain the generated Doc text returned by the Drive connector. It must remain local; raw transcript text is not printed to console or placed in Codex's context. The final status contains only counts.

The workflow checks the configured folders and `main` before acting. It reuses existing Drive source files, retries pending archive Docs, skips video IDs already published, validates every timestamp locally, writes a dispatch-attempt marker before submitting, and will not resend a dispatch with an uncertain result. A successful GitHub API response is not proof of a published commit or a deployed Pages build.

## Register the daily task

The registration script refuses to overwrite a task with the same name and fails unless Windows is configured for Eastern Time. From a non-elevated PowerShell 7 session as the intended user, run:

```powershell
& .\automation\register-daily-task.ps1
```

It registers `LaurelCouncilMinutes-Daily` for the current user with an interactive logon, limited privileges, a hidden PowerShell window, `StartWhenAvailable`, `IgnoreNew` for overlapping runs, and a one-hour time limit. The task runs only while that user is signed in. If the task already exists, inspect it in Task Scheduler; the script will not replace it.

After registration, verify the task's user, next run time, and trigger in Task Scheduler. The script does not start the task immediately. Run the one-off command above when ready to execute a live workflow.

## Inspect a run

Each run writes a short `result.txt` and private Codex JSONL/stderr logs to its run folder. The status should report counts for candidates discovered, already present, collected, uploaded, validated, and published. Inspect the corresponding GitHub Actions run for the commit and Cloudflare build result. A failed validation or uncertain dispatch needs review; the scheduler does not submit a second dispatch automatically.

## References

- [Codex CLI repository](https://github.com/openai/codex) and the installed `codex exec --help` output
- [New-ScheduledTaskTrigger](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)
- [New-ScheduledTaskPrincipal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)
- [New-ScheduledTaskSettingsSet](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)
- [Task Scheduler's StartWhenAvailable behavior](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable)
