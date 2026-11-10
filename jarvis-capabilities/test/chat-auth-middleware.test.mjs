import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual middleware source with a fake database, without booting the
// production HTTP server or providing any production credentials.
const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const start = server.indexOf('async function requireChatAuth(req, res, next) {');
const end = server.indexOf('\nfunction normalizeText(', start);
assert.ok(start >= 0 && end > start, 'middleware not found');
const source = server.slice(start, end);
function harness({legacy = false, auth = {ok: true}, fail = false, pool = {}} = {}) {
  let called = 0, db = 0, registry = 0, authenticated = 0;
  const sandbox = {pool, validToken: () => legacy,
    initializeDatabase: async () => {db++; if (fail) throw new Error('db');},
    initializeAndroidDeviceRegistry: async () => {registry++;},
    authenticateAndroidDevice: async (_pool, args) => {authenticated++; return auth;},
    console: {error() {}}};
  const fn = vm.runInNewContext(source + '\nrequireChatAuth', sandbox);
  const res = {statusCode:200, body:null, status(n) {this.statusCode=n;return this;}, json(b){this.body=b;return this;}};
  return {run: async headers => {await fn({headers},res,()=>{called++});return {called,db,registry,authenticated,status:res.statusCode};}};
}
const headers = {authorization:'Bearer ' + 'a'.repeat(43), 'x-jarvis-device-id':'test-device'};
test('legacy API token remains accepted without database access', async () => {
  const result = await harness({legacy:true}).run({});
  assert.equal(result.called,1); assert.equal(result.db,0); assert.equal(result.authenticated,0);
});
test('valid paired device reaches the chat', async () => {
  const result = await harness().run(headers);
  assert.equal(result.called,1); assert.equal(result.authenticated,1); assert.equal(result.registry,1);
});
test('invalid or revoked device is denied', async () => {
  const result = await harness({auth:{ok:false}}).run(headers);
  assert.equal(result.called,0); assert.equal(result.status,401);
});
test('missing device header or database fails closed', async () => {
  for (const config of [{}, {pool:null}]) {
    const result = await harness(config).run(config.pool === null ? headers : {authorization:headers.authorization});
    assert.equal(result.called,0); assert.equal(result.status,401);
  }
});
test('database errors are unavailable, not falsely classified as revoked', async () => {
  const result = await harness({fail:true}).run(headers);
  assert.equal(result.called,0); assert.equal(result.status,503);
});
