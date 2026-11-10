import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import {initializeAndroidDeviceRegistry, createAndroidPairingCode, enrollAndroidDevice, authenticateAndroidDevice, revokeAndroidDevice} from '../android-device-registry.mjs';

const databaseUrl = process.env.JARVIS_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('JARVIS_TEST_DATABASE_URL deve apontar para PostgreSQL temporário de teste.');
const pool = new pg.Pool({connectionString: databaseUrl});
const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function requireChatAuth(req, res, next) {');
const end = source.indexOf('\nfunction normalizeText(', start);
assert.ok(start >= 0 && end > start);
const middleware = vm.runInNewContext(source.slice(start, end) + '\nrequireChatAuth', {
  pool, validToken: () => false, initializeDatabase: async () => {},
  initializeAndroidDeviceRegistry, authenticateAndroidDevice, console: {error() {}}
});
async function call(deviceId, token) {
  let reached = false;
  const res = {statusCode:200, status(code) {this.statusCode=code;return this;}, json() {return this;}};
  await middleware({headers:{authorization:'Bearer '+token,'x-jarvis-device-id':deviceId}},res,()=>{reached=true;});
  return {reached,status:res.statusCode};
}
test('PostgreSQL: parear, autenticar e revogar bloqueia chat', async () => {
  try {
    await initializeAndroidDeviceRegistry(pool);
    const id = 'test-device-' + Date.now();
    const pairing = await createAndroidPairingCode(pool);
    const linked = await enrollAndroidDevice(pool, {deviceId:id, code:pairing.code});
    assert.deepEqual(await call(id, linked.token), {reached:true,status:200});
    assert.deepEqual(await call(id, 'x'.repeat(43)), {reached:false,status:401});
    await assert.rejects(enrollAndroidDevice(pool, {deviceId:id+'-2', code:pairing.code}), e => e.code === 'PAIRING_CODE_INVALID');
    assert.equal((await revokeAndroidDevice(pool,{deviceId:id})).revoked,true);
    assert.deepEqual(await call(id, linked.token), {reached:false,status:401});
  } finally { await pool.end(); }
});
