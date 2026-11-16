const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function builder() {
  const value = {};
  const chain = new Proxy(value, {
    get(target, property) {
      if (property === 'build') return () => target;
      if (property === 'setFieldName' || property === 'setTitle' || property === 'setInputMode' ||
          property === 'setHostAppDataSource' || property === 'setWorkflowDataSource' ||
          property === 'setIncludeVariables' || property === 'setHeader' || property === 'addWidget' ||
          property === 'addSection' || property === 'setWorkflowAction' || property === 'setHostAppAction') {
        return (...args) => { target[property] = args; return chain; };
      }
      return undefined;
    }
  });
  return chain;
}

function testContext(options = {}) {
  const requests = [];
  const logs = [];
  const props = options.properties || { GITHUB_DISPATCH_TOKEN: 'test-secret-do-not-log' };
  const responseCode = options.responseCode === undefined ? 204 : options.responseCode;
  const context = {
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    URL,
    Array,
    Date,
    Number,
    JSON,
    Math,
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (key) => props[key] || null })
    },
    Utilities: { newBlob: (value) => ({ getBytes: () => Buffer.from(value, 'utf8') }) },
    UrlFetchApp: {
      fetch: (url, request) => {
        requests.push({ url, request });
        if (options.fetchError) throw new Error(`sensitive ${options.fetchError}`);
        return { getResponseCode: () => responseCode, getContentText: () => 'response secret body' };
      }
    },
    CardService: {
      TextInputMode: { PLAIN_TEXT: 'PLAIN_TEXT' },
      newTextInput: builder,
      newHostAppDataSource: builder,
      newWorkflowDataSource: builder,
      newCardBuilder: builder,
      newCardSection: builder
    },
    AddOnsResponseService: {
      newVariableData: () => ({
        values: [],
        addStringValue(value) { this.values.push(value); return this; }
      }),
      newReturnOutputVariablesAction: () => ({
        variables: {},
        addVariableData(id, data) { this.variables[id] = data; return this; }
      }),
      newHostAppAction: () => ({ setWorkflowAction(action) { this.workflowAction = action; return this; } }),
      newRenderActionBuilder: () => ({ setHostAppAction(action) { this.hostAppAction = action; return this; }, build() { return this; } })
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'Code.gs' });
  return { context, requests, logs };
}

function event(markdown) {
  return { workflow: { actionInvocation: { inputs: { markdown: { stringValues: [markdown] } } } } };
}

const markdown = [
  '---',
  'title: "Mayor and City Council Meeting"',
  'date: "2026-11-14"',
  'video_id: "abcdefghijk"',
  '---',
  '',
  '# Mayor and City Council Meeting',
  '',
  '[Source](https://www.youtube.com/watch?v=abcdefghijk&t=1m2s)',
  ''
].join('\n');

test('config card selects prior Studio variables and defines a single markdown field', () => {
  const { context } = testContext();
  const card = context.onConfigPublishMinutes();
  assert.ok(card);
});

test('posts only expected payload with bearer header and returns accepted plus source id', () => {
  const { context, requests, logs } = testContext();
  const response = context.onExecutePublishMinutes(event(markdown));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.github.com/repos/mshish/laurel-md-city-council-minutes/dispatches');
  assert.equal(requests[0].request.headers.Authorization, 'Bearer test-secret-do-not-log');
  assert.deepEqual(JSON.parse(requests[0].request.payload), {
    event_type: 'publish-minutes',
    client_payload: {
      title: 'Mayor and City Council Meeting',
      date: '2026-11-14',
      video_id: 'abcdefghijk',
      markdown
    }
  });
  assert.equal(response.hostAppAction.workflowAction.variables.status.values[0], 'accepted');
  assert.equal(response.hostAppAction.workflowAction.variables.source_id.values[0], 'abcdefghijk');
  assert.deepEqual(logs, []);
});

test('JSON escaping preserves quotes, slashes, and Unicode and enforces serialized payload size', () => {
  const source = markdown.replace('Meeting', 'Meeting \\"quoted\\" — Laurel');
  const { context, requests } = testContext();
  context.onExecutePublishMinutes(event(source));
  assert.equal(JSON.parse(requests[0].request.payload).client_payload.markdown, source);

  const large = markdown.replace('\n# Mayor', `\n${'\\'.repeat(33000)}\n# Mayor`);
  const oversized = testContext();
  assert.throws(() => oversized.context.onExecutePublishMinutes(event(large)), /dispatch_payload_too_large/);
  assert.equal(oversized.requests.length, 0);
});

test('rejects SOURCE_NOT_READY, missing inputs, and malformed or unsafe metadata before fetch', () => {
  for (const input of ['SOURCE_NOT_READY', '---\ntitle: unquoted\ndate: "2026-11-14"\nvideo_id: "abcdefghijk"\n---\nBody']) {
    const { context, requests } = testContext();
    assert.throws(() => context.onExecutePublishMinutes(event(input)));
    assert.equal(requests.length, 0);
  }
  const { context, requests } = testContext();
  assert.throws(() => context.onExecutePublishMinutes({}), /markdown_input_missing/);
  assert.equal(requests.length, 0);
});

test('validates date, video ID, matching YouTube links, and rejects images', () => {
  const badInputs = [
    markdown.replace('2026-11-14', '2026-02-30'),
    markdown.replace('abcdefghijk', 'not-a-video'),
    markdown.replace('watch?v=abcdefghijk', 'watch?v=zyxwvutsrqp'),
    markdown.replace('[Source]', '![Source]')
  ];
  for (const input of badInputs) {
    const { context, requests } = testContext();
    assert.throws(() => context.onExecutePublishMinutes(event(input)), /invalid_markdown/);
    assert.equal(requests.length, 0);
  }
});

test('keeps credentials and remote error details out of logs and surfaced errors', () => {
  for (const options of [{ properties: {} }, { fetchError: 'test-secret-do-not-log' }, { responseCode: 403 }]) {
    const { context, requests, logs } = testContext(options);
    assert.throws(() => context.onExecutePublishMinutes(event(markdown)), (error) => {
      assert.doesNotMatch(error.message, /secret|response|payload/i);
      return true;
    });
    assert.deepEqual(logs, []);
    if (options.properties) assert.equal(requests.length, 0);
  }
});
