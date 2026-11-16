# Workspace Studio minutes publisher

This standalone Apps Script step is an optional publisher for the existing Laurel meeting flow. It receives only the full Markdown returned by Ask Gemini. It does not read Drive transcripts, call a model, archive a document, or act as a webhook relay. Workspace Studio does not show this action until the script is installed as an unpublished add-on through a test deployment.

The step parses the exact quoted `title`, `date`, and `video_id` frontmatter used by `docs/gemini-prompt.md`; checks the metadata and inline YouTube links; serializes the four-field payload expected by `scripts/minutes.js`; and sends it to the fixed repository dispatch endpoint. Markdown and serialized request bodies are limited to 45,000 UTF-8 bytes and 64 KiB respectively. `SOURCE_NOT_READY` is rejected before any network request.

## Create and configure the script project

1. Create a standalone Apps Script project at [script.google.com](https://script.google.com/) and name it `Laurel Minutes Publisher`.
2. Copy `Code.gs` into the project and replace its manifest with this directory's `appsscript.json` using **Project Settings → Show "appsscript.json" manifest file in editor**.
3. In **Project Settings → Script Properties**, add `GITHUB_DISPATCH_TOKEN` with a fine-grained GitHub token restricted to `mshish/laurel-md-city-council-minutes` and the **Contents: read and write** repository permission required by GitHub's repository dispatch endpoint. Do not add the token to flow variables, card fields, code, URLs, or logs.
4. Save and authorize the script when prompted. The only requested OAuth scope is `script.external_request`.

## Install and test in Workspace Studio

Follow Google's documented test-deployment process: in the Apps Script editor, choose **Deploy → Test deployments → Install**, then **Done**. Refresh Workspace Studio/Flows if the action does not appear.

In a test flow, connect Ask Gemini's complete Markdown output to **Publish Laurel meeting minutes → Generated meeting minutes (Markdown)**. Run it with a test response whose frontmatter title/date/video ID match its source and whose links point to that same YouTube ID. The step returns `status=accepted` and `source_id=<video_id>` only after GitHub returns HTTP 204. GitHub's 204 means the dispatch event was accepted; it does not establish that the workflow validated, committed, or published the minutes. Confirm the follow-on workflow separately. Then use the real flow ordering: Ask Gemini → Create Google Doc archive → Publish Laurel meeting minutes.

The step's execution fails with a short generic error code for invalid input or a rejected request. It never logs Markdown, request/response bodies, or the token. Apps Script test deployments and live Workspace Studio behavior still need an owner-run integration test; this repository change does not install or deploy the script.

## Run local tests

From this directory, run:

```sh
node --test tests/publisher.test.cjs
```

The tests run `Code.gs` in a Node VM with mocked Apps Script and Workspace Studio services. They do not make a GitHub request or validate the manifest against Google's live deployment service.

## Official references

- [Build a Workspace Studio step](https://developers.google.com/workspace/add-ons/studio/build-a-step)
- [Collect data with an input variable](https://developers.google.com/workspace/add-ons/studio/input-variables)
- [Pass data between steps with an output variable](https://developers.google.com/workspace/add-ons/studio/output-variables)
- [Workspace Studio event objects](https://developers.google.com/workspace/add-ons/studio/event-objects)
- [Install an unpublished add-on](https://developers.google.com/workspace/add-ons/how-tos/testing-workspace-addons)
- [GitHub: Create a repository dispatch event](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
