/*
 * Laurel City Council meeting transcript collector.
 *
 * YouTube Data API is used for channel, playlist, and video metadata. Caption
 * text uses YouTube's undocumented Android Innertube player/caption endpoints
 * because the documented captions download API is not available for arbitrary
 * public videos. That adapter can break when YouTube changes its private
 * protocol; failures are retried on a later daily poll. This script never
 * downloads video or audio.
 */

var CONFIG = {
  channelHandle: '@LaurelTVOfficial',
  lookbackDays: 45,
  pendingDays: 180,
  maxVideosPerRun: 12,
  maxRunMillis: 240000,
  pendingPrefix: 'TRANSCRIPT_PENDING_V1_',
  handler: 'runDailyPoll',
  timezone: 'America/New_York',
  triggerHour: 7
};

var CAPTION_ADAPTER = {
  playerUrl: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
  clientName: 'ANDROID',
  clientVersion: '20.10.38'
};

function runDailyPoll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    logDiagnostic_('poll_skipped', { reason: 'already_running' });
    return { ok: true, skipped: true };
  }
  try {
    return runDailyPollLocked_();
  } finally {
    lock.releaseLock();
  }
}

function runDailyPollLocked_() {
  var startedAt = Date.now();
  var state = loadState_();
  var counts = { scanned: 0, matched: 0, exported: 0, pending: 0, errors: 0 };
  try {
    var folder = getDestinationFolder_();
    var channel = resolveChannel_();
    var playlistId = channel.contentDetails && channel.contentDetails.relatedPlaylists &&
      channel.contentDetails.relatedPlaylists.uploads;
    if (!playlistId) throw new Error('uploads_playlist_missing');

    var uploads = listRecentUploads_(playlistId);
    counts.scanned = uploads.length;
    addRecentMatches_(state, uploads, Date.now());

    var queue = priorityPendingIds_(state);
    for (var i = 0; i < queue.length; i++) {
      if (i >= CONFIG.maxVideosPerRun || Date.now() - startedAt >= CONFIG.maxRunMillis) break;
      var videoId = queue[i];
      var pending = state.pending[videoId];
      if (!pending) continue;
      counts.matched++;
      try {
        if (hasTranscriptFile_(folder, videoId)) {
          delete state.pending[videoId];
          counts.exported++;
          saveState_(state);
          continue;
        }

        var video = getVideoMetadata_(videoId);
        if (!isFinishedVideo_(video)) {
          pending.lastAttemptAt = new Date().toISOString();
          pending.attempts = (pending.attempts || 0) + 1;
          saveState_(state);
          counts.pending++;
          continue;
        }

        var transcript = fetchTranscript_(videoId);
        if (!transcript) {
          pending.lastAttemptAt = new Date().toISOString();
          pending.attempts = (pending.attempts || 0) + 1;
          saveState_(state);
          counts.pending++;
          continue;
        }

        var transcriptText = formatTranscript_(transcript.events);
        if (!transcriptText) {
          pending.lastAttemptAt = new Date().toISOString();
          pending.attempts = (pending.attempts || 0) + 1;
          saveState_(state);
          counts.pending++;
          continue;
        }

        // Use video ID in the name as the durable idempotency key. The pending
        // record is removed only after Drive confirms the text file was created.
        folder.createFile(videoId + '.txt', buildTranscriptFile_(video, pending, videoId, transcriptText), MimeType.PLAIN_TEXT);
        delete state.pending[videoId];
        saveState_(state);
        counts.exported++;
      } catch (videoError) {
        pending.lastAttemptAt = new Date().toISOString();
        pending.attempts = (pending.attempts || 0) + 1;
        saveState_(state);
        counts.errors++;
      }
    }
    counts.pending = Object.keys(state.pending).length;
    logDiagnostic_('poll_complete', counts);
    return counts;
  } catch (error) {
    // Do not log exception text: UrlFetch errors may contain private caption URLs.
    logDiagnostic_('poll_failed', { stage: 'setup_or_listing', pending: Object.keys(state.pending).length });
    return { ok: false, pending: Object.keys(state.pending).length };
  }
}

function priorityPendingIds_(state) {
  return Object.keys(state.pending).sort(function (a, b) {
    var left = state.pending[a];
    var right = state.pending[b];
    var leftAttempted = !!left.lastAttemptAt;
    var rightAttempted = !!right.lastAttemptAt;
    if (leftAttempted !== rightAttempted) return leftAttempted ? 1 : -1;
    if (leftAttempted && left.lastAttemptAt !== right.lastAttemptAt) {
      return left.lastAttemptAt.localeCompare(right.lastAttemptAt);
    }
    var byPublishedAt = String(left.publishedAt || '').localeCompare(String(right.publishedAt || ''));
    return byPublishedAt || a.localeCompare(b);
  });
}

/** Creates one daily trigger if one does not already exist. Does not run itself. */
function installDailyTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === CONFIG.handler;
  });
  if (existing.length > 0) {
    // Preserve one existing trigger and remove accidental duplicates.
    for (var i = 1; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);
    return { created: false, triggerCount: 1 };
  }
  ScriptApp.newTrigger(CONFIG.handler)
    .timeBased()
    .atHour(CONFIG.triggerHour)
    .everyDays(1)
    .inTimezone(CONFIG.timezone)
    .create();
  return { created: true, triggerCount: 1 };
}

/** Metadata-only setup check; it never fetches caption text or logs secrets. */
function diagnoseConfig() {
  var result = { ok: false, folderAccessible: false, channelResolved: false, triggerInstalled: false };
  try {
    getDestinationFolder_();
    result.folderAccessible = true;
    var channel = resolveChannel_();
    result.channelResolved = !!(channel && channel.id);
    result.pendingCount = Object.keys(loadState_().pending).length;
    result.triggerInstalled = ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getHandlerFunction() === CONFIG.handler;
    });
    result.ok = result.folderAccessible && result.channelResolved;
  } catch (error) {
    result.error = 'check_failed';
  }
  logDiagnostic_('diagnose_config', {
    ok: result.ok,
    folderAccessible: result.folderAccessible,
    channelResolved: result.channelResolved,
    triggerInstalled: result.triggerInstalled,
    pendingCount: result.pendingCount || 0
  });
  return result;
}

function isTargetMeeting_(title, description) {
  // Deliberately select from title only: descriptions may promote unrelated
  // programming. Require the Mayor + City Council phrase and a meeting type.
  var text = String(title || '');
  var council = /\bmayor\s*(?:and|&)\s*(?:the\s+)?city\s+council\b/i.test(text);
  var meeting = /\bmeeting\b|\bwork\s+session\b|\bwork\s+meeting\b/i.test(text);
  return council && meeting;
}

function formatTranscript_(events) {
  var lines = [];
  (events || []).forEach(function (event) {
    if (!event || typeof event.tStartMs !== 'number' || !event.segs) return;
    var text = event.segs.map(function (segment) { return segment && segment.utf8 || ''; }).join('')
      .replace(/\s+/g, ' ').trim();
    if (!text) return;
    var totalSeconds = Math.floor(event.tStartMs / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    lines.push('[' + pad2_(hours) + ':' + pad2_(minutes) + ':' + pad2_(seconds) + '] ' + text);
  });
  return lines.join('\n');
}

function buildTranscriptFile_(video, pending, videoId, transcriptText) {
  var title = String(video && video.snippet && video.snippet.title || pending.title || '');
  var meetingDate = findMeetingDate_(title);
  var dateSource = 'title';
  var dateVerified = true;
  if (!meetingDate && video && video.liveStreamingDetails && video.liveStreamingDetails.actualStartTime) {
    meetingDate = Utilities.formatDate(new Date(video.liveStreamingDetails.actualStartTime), CONFIG.timezone, 'yyyy-MM-dd');
    dateSource = 'actual_stream_start';
    dateVerified = false;
  }
  if (!meetingDate) {
    meetingDate = 'unknown';
    dateSource = 'unavailable';
    dateVerified = false;
  }
  return '---\n' +
    'title: ' + yamlQuoted_(title) + '\n' +
    'date: ' + yamlQuoted_(meetingDate) + '\n' +
    'video_id: ' + yamlQuoted_(videoId) + '\n' +
    'date_source: ' + yamlQuoted_(dateSource) + '\n' +
    'date_verified: ' + yamlQuoted_(dateVerified ? 'true' : 'false') + '\n' +
    '---\n' + transcriptText;
}

function findMeetingDate_(title) {
  var text = String(title || '');
  var match = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return validDate_(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (match) return validDate_(Number(match[3]), Number(match[1]), Number(match[2]));
  var months = 'january february march april may june july august september october november december'.split(' ');
  match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/i);
  if (match) {
    var monthWord = match[1].toLowerCase().replace(/\.$/, '');
    var monthIndex = months.findIndex(function (month) { return month.indexOf(monthWord) === 0; });
    if (monthIndex >= 0) return validDate_(Number(match[3]), monthIndex + 1, Number(match[2]));
  }
  return null;
}

function validDate_(year, month, day) {
  var date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function yamlQuoted_(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
}

function addRecentMatches_(state, uploads, nowMs) {
  var cutoff = nowMs - getLookbackDays_() * 24 * 60 * 60 * 1000;
  uploads.forEach(function (item) {
    var snippet = item.snippet || {};
    var videoId = item.contentDetails && item.contentDetails.videoId;
    if (!videoId || !snippet.publishedAt || Date.parse(snippet.publishedAt) < cutoff) return;
    if (!isTargetMeeting_(snippet.title, snippet.description)) return;
    if (!state.pending[videoId]) {
      state.pending[videoId] = {
        title: String(snippet.title || '').slice(0, 240),
        publishedAt: snippet.publishedAt,
        firstSeenAt: new Date(nowMs).toISOString(),
        attempts: 0
      };
      saveState_(state);
    }
  });
}

function listRecentUploads_(playlistId) {
  var response = YouTube.PlaylistItems.list('snippet,contentDetails', {
    playlistId: playlistId,
    maxResults: 50
  });
  return response.items || [];
}

function resolveChannel_() {
  var handle = PropertiesService.getScriptProperties().getProperty('CHANNEL_HANDLE') || CONFIG.channelHandle;
  var response = YouTube.Channels.list('contentDetails,snippet', { forHandle: handle });
  if (!response.items || response.items.length === 0) throw new Error('channel_not_found');
  return response.items[0];
}

function getVideoMetadata_(videoId) {
  var response = YouTube.Videos.list('snippet,liveStreamingDetails,status', { id: videoId });
  return response.items && response.items[0] || null;
}

function isFinishedVideo_(video) {
  if (!video || !video.liveStreamingDetails || !video.liveStreamingDetails.actualEndTime) return false;
  var broadcast = video.snippet && video.snippet.liveBroadcastContent;
  return broadcast !== 'live' && broadcast !== 'upcoming';
}

function fetchTranscript_(videoId) {
  var playerResponse = UrlFetchApp.fetch(CAPTION_ADAPTER.playerUrl, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      videoId: videoId,
      context: { client: { clientName: CAPTION_ADAPTER.clientName, clientVersion: CAPTION_ADAPTER.clientVersion } }
    })
  });
  if (playerResponse.getResponseCode() !== 200) return null;
  var player = JSON.parse(playerResponse.getContentText());
  var tracks = player.captions && player.captions.playerCaptionsTracklistRenderer &&
    player.captions.playerCaptionsTracklistRenderer.captionTracks || [];
  if (!tracks.length) return null;
  var track = chooseCaptionTrack_(tracks);
  if (!track || !track.baseUrl) return null;
  var captionUrl = track.baseUrl + (track.baseUrl.indexOf('?') >= 0 ? '&' : '?') + 'fmt=json3';
  var captionResponse = UrlFetchApp.fetch(captionUrl, { muteHttpExceptions: true });
  if (captionResponse.getResponseCode() !== 200) return null;
  var captionData = JSON.parse(captionResponse.getContentText());
  return captionData && Array.isArray(captionData.events) ? captionData : null;
}

function chooseCaptionTrack_(tracks) {
  var usable = tracks.filter(function (track) { return !!track.baseUrl; });
  usable.sort(function (a, b) {
    function rank(track) {
      if (track.languageCode === 'en') return 0;
      if (/^en[-_]/i.test(track.languageCode || '')) return 1;
      return 2;
    }
    return rank(a) - rank(b);
  });
  return usable[0] || null;
}

function hasTranscriptFile_(folder, videoId) {
  return folder.getFilesByName(videoId + '.txt').hasNext();
}

function getDestinationFolder_() {
  var folderId = PropertiesService.getScriptProperties().getProperty('DESTINATION_FOLDER_ID');
  if (!folderId) throw new Error('destination_folder_id_missing');
  return DriveApp.getFolderById(folderId);
}

function getLookbackDays_() {
  var configured = Number(PropertiesService.getScriptProperties().getProperty('LOOKBACK_DAYS'));
  if (!configured || !isFinite(configured) || configured < 1) return CONFIG.lookbackDays;
  return Math.min(Math.floor(configured), 120);
}

function loadState_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var state = { pending: {} };
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(CONFIG.pendingPrefix) !== 0) return;
    var videoId = key.slice(CONFIG.pendingPrefix.length);
    try {
      state.pending[videoId] = JSON.parse(all[key]);
    } catch (error) {
      props.deleteProperty(key);
      logDiagnostic_('state_reset', { reason: 'invalid_pending_record' });
    }
  });
  pruneState_(state, Date.now());
  return state;
}

function pruneState_(state, nowMs) {
  var cutoff = nowMs - CONFIG.pendingDays * 24 * 60 * 60 * 1000;
  Object.keys(state.pending).forEach(function (videoId) {
    var firstSeen = Date.parse(state.pending[videoId].firstSeenAt || '');
    if (!firstSeen || firstSeen < cutoff) delete state.pending[videoId];
  });
}

function saveState_(state) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var expected = {};
  Object.keys(state.pending).forEach(function (videoId) {
    var key = CONFIG.pendingPrefix + videoId;
    expected[key] = true;
    props.setProperty(key, JSON.stringify(state.pending[videoId]));
  });
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(CONFIG.pendingPrefix) === 0 && !expected[key]) props.deleteProperty(key);
  });
}

function pad2_(number) {
  return number < 10 ? '0' + number : String(number);
}

function logDiagnostic_(event, metadata) {
  // Intentionally excludes transcript text, caption URLs, and property values.
  console.log(JSON.stringify({ event: event, metadata: metadata }));
}
