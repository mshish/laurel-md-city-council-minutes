var PUBLISHER = {
  dispatchUrl: 'https://api.github.com/repos/mshish/laurel-md-city-council-minutes/dispatches',
  eventType: 'publish-minutes',
  maxMarkdownBytes: 45000,
  maxDispatchBytes: 64 * 1024,
  githubApiVersion: '2026-03-10'
};

/** Makes the Markdown output from Ask Gemini available as a Studio variable. */
function onConfigPublishMinutes() {
  var markdownInput = CardService.newTextInput()
    .setFieldName('markdown')
    .setTitle('Generated meeting minutes (Markdown)')
    .setInputMode(CardService.TextInputMode.PLAIN_TEXT)
    .setHostAppDataSource(
      CardService.newHostAppDataSource().setWorkflowDataSource(
        CardService.newWorkflowDataSource().setIncludeVariables(true)
      )
    );

  return CardService.newCardBuilder()
    .addSection(CardService.newCardSection()
      .setHeader('Publish meeting minutes')
      .addWidget(markdownInput))
    .build();
}

/** Dispatches validated minutes. It never logs the event, request, or response. */
function onExecutePublishMinutes(event) {
  var markdown = getMarkdownInput_(event);
  if (markdown.trim() === 'SOURCE_NOT_READY') {
    throw new Error('source_not_ready');
  }

  var meeting = parseMeetingMarkdown_(markdown);
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_DISPATCH_TOKEN');
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('publisher_not_configured');
  }

  var requestBody = JSON.stringify({
    event_type: PUBLISHER.eventType,
    client_payload: {
      title: meeting.title,
      date: meeting.date,
      video_id: meeting.video_id,
      markdown: markdown
    }
  });
  if (utf8Bytes_(requestBody) > PUBLISHER.maxDispatchBytes) {
    throw new Error('dispatch_payload_too_large');
  }

  var response;
  try {
    response = UrlFetchApp.fetch(PUBLISHER.dispatchUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': PUBLISHER.githubApiVersion
      },
      payload: requestBody,
      muteHttpExceptions: true
    });
  } catch (_error) {
    throw new Error('dispatch_request_failed');
  }

  if (!response || response.getResponseCode() !== 204) {
    throw new Error('dispatch_rejected');
  }

  var statusData = AddOnsResponseService.newVariableData().addStringValue('accepted');
  var sourceData = AddOnsResponseService.newVariableData().addStringValue(meeting.video_id);
  var outputAction = AddOnsResponseService.newReturnOutputVariablesAction()
    .addVariableData('status', statusData)
    .addVariableData('source_id', sourceData);

  return AddOnsResponseService.newRenderActionBuilder()
    .setHostAppAction(AddOnsResponseService.newHostAppAction().setWorkflowAction(outputAction))
    .build();
}

function getMarkdownInput_(event) {
  var inputs = event && event.workflow && event.workflow.actionInvocation &&
    event.workflow.actionInvocation.inputs;
  var values = inputs && inputs.markdown && inputs.markdown.stringValues;
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error('markdown_input_missing');
  }
  return values[0];
}

/**
 * Parses the exact quoted metadata shape emitted by the configured Gemini prompt.
 * Keeping this parser narrow avoids evaluating arbitrary YAML in Apps Script.
 */
function parseMeetingMarkdown_(source) {
  if (typeof source !== 'string' || !source.trim() || utf8Bytes_(source) > PUBLISHER.maxMarkdownBytes) {
    throw new Error('invalid_markdown');
  }
  var normalized = source.replace(/\r\n?/g, '\n');
  var lines = normalized.split('\n');
  if (lines.length < 6 || lines[0] !== '---') throw new Error('invalid_markdown');

  var expected = ['title', 'date', 'video_id'];
  var metadata = {};
  for (var i = 0; i < expected.length; i++) {
    var match = /^(title|date|video_id): "((?:[^"\\]|\\["\\])*)"$/.exec(lines[i + 1]);
    if (!match || match[1] !== expected[i]) throw new Error('invalid_markdown');
    metadata[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
  }
  if (lines[4] !== '---') throw new Error('invalid_markdown');

  var body = lines.slice(5).join('\n');
  if (!body.trim()) throw new Error('invalid_markdown');
  validateMetadata_(metadata);
  validateBodyLinks_(body, metadata.video_id);

  return metadata;
}

function validateMetadata_(metadata) {
  if (typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title !== metadata.title.trim() ||
      metadata.title.length > 180 || /[\u0000-\u001f\u007f]/.test(metadata.title)) {
    throw new Error('invalid_markdown');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.date)) throw new Error('invalid_markdown');
  var date = new Date(metadata.date + 'T00:00:00.000Z');
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== metadata.date) {
    throw new Error('invalid_markdown');
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(metadata.video_id)) throw new Error('invalid_markdown');
}

/** Mirrors the publisher's link/image restrictions for ordinary inline Markdown links. */
function validateBodyLinks_(body, videoId) {
  if (/!\[[^\]]*\]\(/.test(body)) throw new Error('invalid_markdown');
  var linkPattern = /\[[^\]]*\]\(([^)]*)\)/g;
  var match;
  while ((match = linkPattern.exec(body)) !== null) {
    var destination = match[1].trim().split(/\s+/, 1)[0];
    if (destination.charAt(0) === '<' && destination.charAt(destination.length - 1) === '>') {
      destination = destination.slice(1, -1);
    }
    validateYoutubeLink_(destination, videoId);
  }
}

function validateYoutubeLink_(value, videoId) {
  var url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new Error('invalid_markdown');
  }
  var host = url.hostname.toLowerCase();
  var hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'];
  if (url.protocol !== 'https:' || hosts.indexOf(host) < 0 || url.port || url.username || url.password) {
    throw new Error('invalid_markdown');
  }
  var pathParts = url.pathname.split('/').filter(function (part) { return part !== ''; });
  var isShort = host === 'youtu.be' || host === 'www.youtu.be';
  var linkedId;
  if (isShort && pathParts.length === 1 && /^[A-Za-z0-9_-]{11}$/.test(pathParts[0])) {
    linkedId = pathParts[0];
  } else if (host.endsWith('youtube.com') && url.pathname === '/watch') {
    linkedId = url.searchParams.get('v');
  } else if (host.endsWith('youtube.com') && /^(shorts|live)$/.test(pathParts[0] || '') &&
             pathParts.length === 2 && /^[A-Za-z0-9_-]{11}$/.test(pathParts[1])) {
    linkedId = pathParts[1];
  } else {
    throw new Error('invalid_markdown');
  }
  if (linkedId !== videoId) throw new Error('invalid_markdown');

  ['t', 'start', 'time_continue'].forEach(function (key) {
    url.searchParams.getAll(key).forEach(function (timestamp) {
      if (!validTimestamp_(timestamp)) throw new Error('invalid_markdown');
    });
  });
}

function validTimestamp_(value) {
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value));
  if (/^\d{1,3}(?::[0-5]?\d){1,2}$/.test(value)) {
    var clockSeconds = value.split(':').map(Number).reduce(function (total, part) {
      return total * 60 + part;
    }, 0);
    return Number.isSafeInteger(clockSeconds);
  }
  var match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
  if (!match || !match[1] && !match[2] && !match[3]) return false;
  if (Number(match[2] || 0) > 59 || Number(match[3] || 0) > 59) return false;
  var durationSeconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return Number.isSafeInteger(durationSeconds);
}

function utf8Bytes_(value) {
  return Utilities.newBlob(value, 'text/plain').getBytes().length;
}
