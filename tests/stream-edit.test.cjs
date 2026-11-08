const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const originalLoad = Module._load;
const oldTs = require.extensions['.ts'];
let mongo, rows, probes, saves, refreshes, throwsProbe;
const result = { ok: true, status: 'healthy', latency: 25, mediaVerified: true, reason: 'verified', deliveryMisses: 0 };
const mocks = {
  '@/lib/db': { connectToDatabase: async () => mongo ? {} : null, databaseUnavailable: () => null },
  '@/lib/adminAuth': { authorizeAdminRequest: async req => ({ ok: true, body: await req.json() }) },
  '@/lib/inMemoryStore': { inMemoryDb: { getStreams: () => rows, saveState: () => saves++ } },
  '@/lib/maintenanceRunner': { refreshChannelLinks: async () => refreshes++ },
  '@/lib/streamProbe': { checkHlsStream: async (url, opts) => {
    probes.push({ url, headers: opts.headers });
    if (throwsProbe) throw new Error('probe unavailable');
    return result;
  } },
  '@/models/StreamLink': { findById: async id => rows.find(r => r._id === id), find: query => ({ select: () => ({ lean: async () => rows.filter(r => r._id !== query._id.$ne && r.channelId === query.channelId) }) }) },
};
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
Module._load = function(request, parent, isMain) {
  if (mocks[request]) return mocks[request];
  if (request.startsWith('@/')) request = path.join(root, request.slice(2));
  return originalLoad.call(this, request, parent, isMain);
};
const { PATCH } = require('../app/api/admin/streams/[id]/route.ts');
after(() => { Module._load = originalLoad; if (oldTs) require.extensions['.ts'] = oldTs; else delete require.extensions['.ts']; });
const id = '6ab5c72de29c995275489e5c';
function reset(mode) {
  mongo = mode; probes = []; saves = 0; refreshes = 0; throwsProbe = false;
  rows = [{ _id: id, channelId: 'channel', url: 'https://one.example/old.m3u8', headers: { Authorization: 'test-only' }, pinned: true, adminDisabled: true, manual: false, status: 'broken', failedAttempts: 8, deliveryMisses: 8, deliveryHidden: true, lastCheck: { reason: 'old' }, save: async () => saves++, toObject() { return { ...this }; } }];
}
async function edit(url, target = id) {
  return PATCH({ json: async () => ({ action: 'edit', url }) }, { params: { id: target } });
}
for (const mode of [false, true]) {
  const store = mode ? 'Mongo' : 'memory';
  test(`${store}: HTTP edit persists exact URL, resets health, retains controls and drops headers`, async () => {
    reset(mode);
    const response = await edit('  http://two.example/live.m3u8?token=ABC  ');
    assert.equal(response.status, 200);
    assert.equal(rows[0].url, 'http://two.example/live.m3u8?token=ABC');
    assert.equal(rows[0].manual, true);
    assert.equal(rows[0].pinned, true);
    assert.equal(rows[0].adminDisabled, true);
    assert.equal(rows[0].headers, undefined);
    assert.equal(rows[0].failedAttempts, 0);
    assert.equal(rows[0].deliveryHidden, false);
    assert.equal(rows[0].lastCheck.healthStatus, result.status);
    assert.equal(saves, 1); assert.equal(refreshes, 1);
    assert.deepEqual(probes, [{ url: rows[0].url, headers: undefined }]);
  });
  test(`${store}: same-origin HTTPS retains headers; cross-origin HTTPS discards them`, async () => {
    reset(mode);
    assert.equal((await edit('https://one.example/new.m3u8')).status, 200);
    assert.deepEqual(probes[0].headers, { Authorization: 'test-only' });
    assert.equal((await edit('https://two.example/new.m3u8')).status, 200);
    assert.equal(probes[1].headers, undefined);
  });
  test(`${store}: HTTP and HTTPS endpoints remain distinct`, async () => {
    reset(mode);
    rows.push({ _id: 'other', channelId: 'channel', url: 'https://two.example/live' });
    assert.equal((await edit('http://two.example/live')).status, 200);
    assert.equal(rows[0].url, 'http://two.example/live');
  });
  test(`${store}: invalid and duplicate edits do not save or probe`, async () => {
    reset(mode);
    for (const url of ['', 'ftp://one.example/a', 'https://user:pass@one.example/a', 'not a url']) assert.equal((await edit(url)).status, 400);
    rows.push({ _id: 'other', channelId: 'channel', url: 'https://two.example/live' });
    assert.equal((await edit('https://two.example/live')).status, 409);
    assert.equal(rows[0].url, 'https://one.example/old.m3u8');
    assert.equal(probes.length, 0); assert.equal(saves, 0);
  });
}
test('memory: thrown probe leaves original endpoint untouched', async () => {
  reset(false); throwsProbe = true;
  const original = { ...rows[0] };
  assert.equal((await edit('http://two.example/new')).status, 500);
  assert.deepEqual(rows[0], original); assert.equal(saves, 0);
});
test('Mongo missing ID never falls back to memory', async () => {
  reset(true); rows[0]._id = 'memory-id';
  assert.equal((await edit('http://two.example/new', 'memory-id')).status, 404);
  assert.equal(probes.length, 0);
});
