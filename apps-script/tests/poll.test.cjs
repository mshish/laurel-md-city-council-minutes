const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures++;
    console.error('FAIL ' + name + ': ' + error.message);
  }
}

function createHarness(options = {}) {
  const properties = new Map(Object.entries({
    DESTINATION_FOLDER_ID: 'folder-1',
    ...options.properties
  }));
  const files = new Map();
  const logs = [];
  const calls = { video: 0, videoIds: [], player: 0, captions: 0, created: 0 };
  let captionAvailable = options.captionAvailable || false;
  const state = {
    contentDetails: { relatedPlaylists: { uploads: 'uploads-1' } },
    id: 'channel-1'
  };
  const upload = {
    contentDetails: { videoId: 'video-1' },
    snippet: {
      publishedAt: new Date().toISOString(),
      title: 'Mayor and City Council Work Session',
      description: ''
    }
  };
  const ctx = {
    console: { log: (line) => logs.push(line) },
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    isFinite,
    MimeType: { PLAIN_TEXT: 'text/plain' },
    Utilities: { formatDate: (date, zone, format) => {
      assert.equal(zone, 'America/New_York');
      const localDate = new Date(date.getTime() - 5 * 60 * 60 * 1000);
      return format === 'yyyy' ? String(localDate.getUTCFullYear()) : localDate.toISOString().slice(0, 10);
    } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.has(key) ? properties.get(key) : null,
        setProperty: (key, value) => properties.set(key, value),
        getProperties: () => Object.fromEntries(properties),
        deleteProperty: (key) => properties.delete(key)
      })
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    DriveApp: {
      getFolderById: () => ({
        getFilesByName: (name) => ({ hasNext: () => files.has(name) }),
        createFile: (name, content) => {
          calls.created++;
          files.set(name, content);
          return {};
        }
      })
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({
        timeBased() { return this; },
        atHour(hour) { this.hour = hour; return this; },
        everyDays(days) { this.days = days; return this; },
        inTimezone(zone) { this.zone = zone; return this; },
        create() { return {}; }
      })
    },
    YouTube: {
      Channels: { list: () => ({ items: [state] }) },
      PlaylistItems: { list: () => ({ items: options.uploads || [upload] }) },
      Videos: {
        list: (parts, params) => {
          calls.video++;
          calls.videoIds.push(params.id);
          return { items: [{
            snippet: { title: 'Mayor and City Council Work Session - November 14, 2026', liveBroadcastContent: 'none' },
            liveStreamingDetails: { actualStartTime: '2026-11-15T00:30:00Z', actualEndTime: new Date().toISOString() }
          }] };
        }
      }
    },
    UrlFetchApp: {
      fetch: (url, request = {}) => {
        if (String(url).includes('/youtubei/v1/player')) {
          calls.player++;
          assert.equal(request.method, 'post');
          assert.equal(JSON.parse(request.payload).videoId, calls.videoIds[calls.player - 1]);
          if (!captionAvailable) return response(200, { captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } } });
          return response(200, {
            playabilityStatus: { status: 'OK', reason: options.privateServerText || 'ordinary' },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [
              { languageCode: 'en', baseUrl: options.captionUrl || 'https://captions.invalid/v1' }
            ] } }
          });
        }
        calls.captions++;
        assert.match(String(url), /fmt=json3/);
        return response(200, { events: [
          { tStartMs: 1230, segs: [{ utf8: options.captionText || 'Council ' }, { utf8: 'meeting.' }] },
          { tStartMs: 3661000, segs: [{ utf8: 'Next.' }] }
        ] });
      }
    }
  };
  function response(code, body) {
    const text = JSON.stringify(body);
    return {
      getResponseCode: () => code,
      getContentText: () => text,
      getContent: () => Array.from({ length: text.length })
    };
  }
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'Code.gs' });
  return {
    ctx, files, properties, calls, logs,
    setCaptionAvailable(value) { captionAvailable = value; }
  };
}

test('meeting filter requires Mayor and City Council meeting terms in title', () => {
  const { ctx } = createHarness();
  assert.equal(ctx.isTargetMeeting_('Mayor and City Council Meeting', ''), true);
  assert.equal(ctx.isTargetMeeting_('Mayor & City Council Work Session', ''), true);
  assert.equal(ctx.isTargetMeeting_('City Council Work Session', ''), false);
  assert.equal(ctx.isTargetMeeting_("Mayor's Update", 'Community announcements'), false);
  assert.equal(ctx.isTargetMeeting_('Planning Commission Meeting', ''), false);
  assert.equal(ctx.isTargetMeeting_('Laurel Living in Focus', 'Mayor and City Council Meeting'), false);
});

test('JSON3 caption segments become transcript-only lines with HH:MM:SS timestamps', () => {
  const { ctx } = createHarness();
  assert.equal(ctx.formatTranscript_([
    { tStartMs: 1230, segs: [{ utf8: ' A ' }, { utf8: 'line. ' }] },
    { tStartMs: 3661000, segs: [{ utf8: 'Later.' }] },
    { segs: [{ utf8: 'ignore missing time' }] }
  ]), '[00:00:01] A line.\n[01:01:01] Later.');
});

test('caption absence stays pending, then exports once captions arrive', () => {
  const harness = createHarness();
  const first = harness.ctx.runDailyPoll();
  assert.equal(first.pending, 1);
  assert.equal(harness.files.size, 0);
  assert.equal(harness.properties.has('TRANSCRIPT_PENDING_V1_video-1'), true);

  harness.setCaptionAvailable(true);
  const second = harness.ctx.runDailyPoll();
  assert.equal(second.exported, 1);
  assert.equal(harness.files.size, 1);
  assert.equal(harness.files.get('video-1.txt'), '---\ntitle: "Mayor and City Council Work Session - November 14, 2026"\ndate: "2026-11-14"\nvideo_id: "video-1"\ndate_source: "title"\ndate_verified: "true"\n---\n[00:00:01] Council meeting.\n[01:01:01] Next.');

  harness.ctx.runDailyPoll();
  assert.equal(harness.calls.created, 1);
});

test('new meetings are processed ahead of more than 12 older caption retries', () => {
  const now = Date.now();
  const properties = {};
  for (let index = 0; index < 15; index++) {
    const id = 'old-' + String(index).padStart(2, '0');
    properties['TRANSCRIPT_PENDING_V1_' + id] = JSON.stringify({
      title: 'Mayor and City Council Meeting',
      publishedAt: new Date(now - (20 + index) * 86400000).toISOString(),
      firstSeenAt: new Date(now - 2 * 86400000).toISOString(),
      lastAttemptAt: new Date(now - (15 - index) * 60000).toISOString(),
      attempts: 1
    });
  }
  const freshUpload = {
    contentDetails: { videoId: 'new-meeting' },
    snippet: {
      publishedAt: new Date(now).toISOString(),
      title: 'Mayor and City Council Special Meeting',
      description: ''
    }
  };
  const harness = createHarness({ properties, uploads: [freshUpload] });
  harness.ctx.runDailyPoll();
  assert.equal(harness.calls.videoIds.length, 12);
  assert.equal(harness.calls.videoIds[0], 'new-meeting');
  assert.equal(harness.calls.videoIds[1], 'old-00');
});

test('protocol fetch requests caption text only and does not fetch media', () => {
  const harness = createHarness({ captionAvailable: true });
  harness.ctx.runDailyPoll();
  assert.equal(harness.calls.player, 1);
  assert.equal(harness.calls.captions, 1);
  assert.equal(harness.calls.created, 1);
});

test('caption diagnostic returns only safe metadata and counts without changing pending state', () => {
  const secret = 'DO_NOT_LOG_TRANSCRIPT_OR_TOKEN';
  const captionUrl = 'https://captions.invalid/v1?token=' + secret;
  const harness = createHarness({
    properties: {
      'TRANSCRIPT_PENDING_V1_video-1': JSON.stringify({
        title: 'Mayor and City Council Work Session',
        publishedAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        attempts: 1
      })
    },
    captionAvailable: true,
    captionUrl,
    captionText: secret,
    privateServerText: secret
  });
  const before = [...harness.properties.entries()];
  const result = harness.ctx.diagnoseCaptionAccess();
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].finished, true);
  assert.equal(result.videos[0].player_http, 200);
  assert.equal(result.videos[0].playability_status, 'OK');
  assert.equal(result.videos[0].english_tracks, 1);
  assert.equal(result.videos[0].timedtext_http, 200);
  assert.equal(result.videos[0].event_count, 2);
  assert.equal(result.videos[0].line_count, 2);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(harness.logs.join('\n').includes(secret), false);
  assert.deepEqual([...harness.properties.entries()], before);
});

test('meeting date is not inferred from upload date and stream-start fallback is labeled unverified', () => {
  const { ctx } = createHarness();
  assert.equal(ctx.findMeetingDate_('City Council Work Session - 11/14/2026'), '2026-11-14');
  const streamStart = '2026-10-07T16:00:00Z';
  assert.equal(ctx.findMeetingDate_('Virtual Mayor and City Council Work Session 10/7/26', streamStart), '2026-10-07');
  assert.equal(ctx.findMeetingDate_('Virtual 21st Mayor and City Council Meeting 10/14/26', '2026-10-14T16:00:00Z'), '2026-10-14');
  assert.equal(ctx.findMeetingDate_('In-Person 22nd Mayor and City Council Meeting 10/26/26', '2026-10-26T16:00:00Z'), '2026-10-26');
  assert.equal(ctx.findMeetingDate_('Mayor and City Council Meeting 10/7/25', streamStart), null);
  assert.equal(ctx.findMeetingDate_('Mayor and City Council Meeting 10/7/26'), null);
  assert.equal(ctx.findMeetingDate_('City Council Work Session'), null);
  const metadata = ctx.buildTranscriptFile_(
    { snippet: { title: 'City Council Work Session' }, liveStreamingDetails: { actualStartTime: '2026-11-15T00:30:00Z' } },
    { title: 'City Council Work Session' }, 'video-2', '[00:00:01] Hello.'
  );
  assert.match(metadata, /date: "2026-11-14"/);
  assert.match(metadata, /date_source: "actual_stream_start"/);
  assert.match(metadata, /date_verified: "false"/);
  const mismatch = ctx.buildTranscriptFile_(
    { snippet: { title: 'Mayor and City Council Meeting 10/7/25' }, liveStreamingDetails: { actualStartTime: streamStart } },
    { title: 'Mayor and City Council Meeting 10/7/25' }, 'video-3', '[00:00:01] Hello.'
  );
  assert.match(mismatch, /date: "2026-10-07"/);
  assert.match(mismatch, /date_source: "actual_stream_start"/);
  assert.match(mismatch, /date_verified: "false"/);
});

if (failures) process.exitCode = 1;
