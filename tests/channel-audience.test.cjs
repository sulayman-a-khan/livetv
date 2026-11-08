/**
 * Audience filtering: the website may only be handed HTTPS stream URLs, while
 * the native app gets every usable link. Runs the real response functions over
 * mocked storage so the filter is proven where it actually applies.
 */
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const originalLoad = Module._load;
const oldTs = require.extensions['.ts'];

let mongo = true;
let channels = [];
let streams = [];

const mocks = {
  'next/server': {
    NextRequest: class {},
    NextResponse: {
      json: (body, init = {}) => ({
        status: init.status || 200,
        body,
        headers: init.headers || {},
      }),
    },
  },
  mongoose: { __esModule: true, default: { isValidObjectId: () => true } },
  '@/lib/db': {
    connectToDatabase: async () => (mongo ? {} : null),
    databaseUnavailable: () => null,
  },
  '@/lib/inMemoryStore': {
    inMemoryDb: { getChannels: () => channels, getStreams: () => streams },
  },
  '@/lib/utils': {
    getChannelLogo: (name, logo) => logo || `logo:${name}`,
  },
  '@/lib/categories': {
    getCategoryBySlug: () => undefined,
    isChannelCategory: () => true,
  },
  '@/models/Channel': {
    __esModule: true,
    default: {
      find: () => ({ sort: () => ({ select: () => ({ lean: async () => channels }) }) }),
      findOne: (query) => ({
        lean: async () => channels.find((c) => String(c._id) === String(query._id)) || null,
      }),
    },
  },
  '@/models/StreamLink': {
    __esModule: true,
    default: {
      find: (query = {}) => ({
        sort: () => ({
          select: () => ({
            lean: async () => {
              const cid = query.channelId;
              if (cid && typeof cid === 'object' && Array.isArray(cid.$in)) {
                const ids = cid.$in.map(String);
                return streams.filter((s) => ids.includes(String(s.channelId)));
              }
              if (cid) return streams.filter((s) => String(s.channelId) === String(cid));
              return streams;
            },
          }),
        }),
      }),
    },
  },
};

require.extensions['.ts'] = (mod, filename) =>
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename
  );

Module._load = function (request, parent, isMain) {
  if (mocks[request]) return mocks[request];
  if (request.startsWith('@/')) request = path.join(root, request.slice(2));
  return originalLoad.call(this, request, parent, isMain);
};

const { channelCatalogueResponse } = require('../lib/channelCatalogueResponse.ts');
const { channelDetailResponse } = require('../lib/channelDetailResponse.ts');

after(() => {
  Module._load = originalLoad;
  if (oldTs) require.extensions['.ts'] = oldTs;
  else delete require.extensions['.ts'];
});

function reset(mode) {
  mongo = mode;
  channels = [
    { _id: 'mixed', name: 'Mixed', isPinned: true, priorityOrder: 1, category: 'All' },
    { _id: 'httponly', name: 'HTTP Only', isPinned: true, priorityOrder: 2, category: 'All' },
    { _id: 'blocked', name: 'Blocked', isPinned: true, priorityOrder: 3, category: 'All' },
  ];
  streams = [
    {
      _id: 'https-link',
      channelId: 'mixed',
      url: 'https://origin.example/live.m3u8',
      status: 'active',
      latency: 90,
      priority: 2,
      failedAttempts: 0,
    },
    {
      _id: 'http-link',
      channelId: 'mixed',
      url: 'http://origin.example/live.m3u8',
      status: 'active',
      latency: 20,
      priority: 1,
      failedAttempts: 0,
    },
    {
      _id: 'only-http',
      channelId: 'httponly',
      url: 'http://other.example/live.m3u8',
      status: 'active',
      latency: 10,
      priority: 1,
      failedAttempts: 0,
    },
    {
      _id: 'cors-blocked',
      channelId: 'blocked',
      url: 'https://blocked.example/live.m3u8',
      status: 'active',
      latency: 10,
      priority: 1,
      failedAttempts: 0,
      browserBlocker: 'CORS_BLOCKED',
    },
  ];
}

const request = { url: 'https://soluplay.example/api/channels' };

for (const mode of [true, false]) {
  const store = mode ? 'Mongo' : 'memory';

  test(`${store}: the web catalogue lists HTTPS links only and drops HTTP-only channels`, async () => {
    reset(mode);
    const response = await channelCatalogueResponse(request, 'web');
    assert.equal(response.status, 200);
    assert.equal(response.body.count, 1);
    const mixed = response.body.channels.find((c) => c._id === 'mixed');
    assert.ok(mixed);
    assert.equal(mixed.activeStreamCount, 1);
    assert.equal(mixed.primaryStream.url, 'https://origin.example/live.m3u8');
    assert.equal(response.body.channels.some((c) => c._id === 'httponly'), false);
    assert.equal(response.body.channels.some((c) => c._id === 'blocked'), false);
    assert.equal(JSON.stringify(response.body).includes('http://'), false);
  });

  test(`${store}: the native catalogue keeps both protocols`, async () => {
    reset(mode);
    const response = await channelCatalogueResponse(request, 'native');
    assert.equal(response.status, 200);
    assert.equal(response.body.count, 3);
    const mixed = response.body.channels.find((c) => c._id === 'mixed');
    assert.equal(mixed.activeStreamCount, 2);
    const httponly = response.body.channels.find((c) => c._id === 'httponly');
    assert.equal(httponly.primaryStream.url, 'http://other.example/live.m3u8');
    assert.equal(response.body.channels.find((c) => c._id === 'blocked').activeStreamCount, 1);
  });

  test(`${store}: a web detail hides HTTP and reports an HTTP-only channel unplayable`, async () => {
    reset(mode);
    const mixed = await channelDetailResponse(request, 'mixed', 'web');
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.playable, true);
    assert.deepEqual(
      mixed.body.channel.streams.map((s) => s.url),
      ['https://origin.example/live.m3u8']
    );

    const onlyHttp = await channelDetailResponse(request, 'httponly', 'web');
    assert.equal(onlyHttp.status, 200);
    assert.equal(onlyHttp.body.playable, false);
    assert.deepEqual(onlyHttp.body.channel.streams, []);
    assert.equal(JSON.stringify(onlyHttp.body).includes('http://'), false);

    // HTTPS is not enough: a link the probe recorded as browser-blocked is not
    // offered to the website either, though the app's own stack may still play it.
    const blocked = await channelDetailResponse(request, 'blocked', 'web');
    assert.equal(blocked.body.playable, false);
    assert.deepEqual(blocked.body.channel.streams, []);
  });

  test(`${store}: a native detail keeps the HTTP mirror`, async () => {
    reset(mode);
    const response = await channelDetailResponse(request, 'httponly', 'native');
    assert.equal(response.status, 200);
    assert.equal(response.body.playable, true);
    assert.deepEqual(
      response.body.channel.streams.map((s) => s.url),
      ['http://other.example/live.m3u8']
    );
    assert.equal(response.body.channel.streams[0].priority, 1);

    const blocked = await channelDetailResponse(request, 'blocked', 'native');
    assert.equal(blocked.body.playable, true);
    assert.equal(blocked.body.channel.streams[0].url, 'https://blocked.example/live.m3u8');
  });
}