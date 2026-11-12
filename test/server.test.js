// Starts the real server on a random port with an in-memory database and drives it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { openStore } from '../server/store.js';
import { APP, KEY, SALT, gen, pathOf } from './vectors.js';

let server;
let base;
const logs = [];
const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonetix-vite-dist-'));
fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');

before(async () => {
  server = createApp({
    store: openStore(':memory:'),
    appId: APP, linkSalt: SALT, postbackKey: KEY,
    staticDir, loginAttempts: 6, signupsPerHour: 50,
    log: (level, msg, data) => logs.push({ level, msg, data }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async function call(p, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, json, headers: res.headers, text };
  };
}
const pb = async (url) => (await fetch(base + (url.startsWith('/') ? url : pathOf(url)))).status;

test('sign up, session cookie, signed link for the session user only', async () => {
  const alice = client();
  const r = await alice('/api/signup', { method: 'POST', body: { email: 'Alice@Example.com', password: 'correct horse battery', ageConfirmed: true } });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const me = await alice('/api/me');
  assert.equal(me.json.user.email, 'alice@example.com');
  assert.equal(me.json.balance, '0');
  const link = await alice('/api/offerwall-link?user_id=999');
  assert.equal(link.status, 200);
  assert.equal(link.headers.get('cache-control'), 'private, no-store');
  assert.equal(link.json.url, gen('x', me.json.user.id, 1, 1).wall + '&sub1=react_vite');
  assert.ok(!JSON.stringify(link.json).includes(SALT));
});

test('sign-up is rate limited per IP address', async () => {
  const limited = createApp({ store: openStore(':memory:'), appId: APP, linkSalt: SALT, postbackKey: KEY, signupsPerHour: 2, log: () => {} });
  await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${limited.address().port}/api/signup`;
  const codes = [];
  for (const n of [1, 2, 3]) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `u${n}@example.com`, password: 'long enough password', ageConfirmed: true }) });
    codes.push(r.status);
  }
  limited.close();
  assert.deepEqual(codes, [201, 201, 429]);
});

test('sign-up rules: 16+, one account per email, real email, long password', async () => {
  const c = client();
  const post = (body) => c('/api/signup', { method: 'POST', body: { password: 'long enough password', ageConfirmed: true, ...body } });
  assert.equal((await post({ email: 'bob@example.com', ageConfirmed: false })).status, 400);
  assert.equal((await post({ email: 'not-an-email' })).status, 400);
  assert.equal((await post({ email: 'bob@example.com', password: 'short' })).status, 400);
  assert.equal((await post({ email: 'bob@example.com' })).status, 201);
  assert.equal((await client()('/api/signup', { method: 'POST', body: { email: 'BOB@example.com', password: 'another password 1', ageConfirmed: true } })).status, 409);
});

test('no session: 401 for /api/me and the link', async () => {
  const anon = client();
  assert.equal((await anon('/api/me')).status, 401);
  assert.equal((await anon('/api/offerwall-link')).status, 401);
  assert.equal((await anon('/api/me', { headers: { cookie: 'sid=forged' } })).status, 401);
});

test('cross-site and non-JSON writes are refused', async () => {
  const c = client();
  const form = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(form.status, 400);
  const cross = await c('/api/login', { method: 'POST', body: { email: 'bob@example.com', password: 'long enough password' }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 400);
});

test('login, wrong password, rate limit', async () => {
  const c = client();
  assert.equal((await c('/api/login', { method: 'POST', body: { email: 'bob@example.com', password: 'long enough password' } })).status, 200);
  assert.equal((await c('/api/me')).json.user.email, 'bob@example.com');
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await client()('/api/login', { method: 'POST', body: { email: 'bob@example.com', password: 'wrong password' } })).status);
  }
  assert.ok(statuses.includes(401));
  assert.equal(statuses.at(-1), 429);
});

test('logout ends the session on the server', async () => {
  const c = client();
  await c('/api/signup', { method: 'POST', body: { email: 'carol@example.com', password: 'long enough password', ageConfirmed: true } });
  const stolen = (await c('/api/me')).status;
  assert.equal(stolen, 200);
  assert.equal((await c('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await c('/api/me')).status, 401);
});

test('postbacks: credit once, decimals, reversal, history', async () => {
  const c = client();
  await c('/api/signup', { method: 'POST', body: { email: 'dave@example.com', password: 'long enough password', ageConfirmed: true } });
  const id = (await c('/api/me')).json.user.id;

  assert.equal(await pb(gen('tx_1', id, '150', 1).postback), 200);
  assert.equal(await pb(gen('tx_1', id, '150', 1).postback), 200);
  assert.equal(await pb(gen('tx_2', id, '0.375', 1).postback), 200);
  assert.equal(await pb(gen('tx_3', id, '1.23456', 1).postback), 200);
  let me = (await c('/api/me')).json;
  assert.equal(me.balance, '151.60956');
  assert.equal(me.history.length, 3);

  assert.equal(await pb(gen('tx_1', id, '150', 2).postback), 200);
  assert.equal(await pb(gen('tx_1', id, '150', 2).postback), 200);
  me = (await c('/api/me')).json;
  assert.equal(me.balance, '1.60956');
  assert.equal(me.history.find((h) => h.id === 'tx_1').state, 'reversed');
});

test('postbacks: 20 parallel copies credit once', async () => {
  const c = client();
  await c('/api/signup', { method: 'POST', body: { email: 'erin@example.com', password: 'long enough password', ageConfirmed: true } });
  const id = (await c('/api/me')).json.user.id;
  const url = gen('tx_par', id, '315', 1).postback;
  const codes = await Promise.all(Array.from({ length: 20 }, () => pb(url)));
  assert.deepEqual([...new Set(codes)], [200]);
  assert.equal((await c('/api/me')).json.balance, '315');
});

test('postbacks: reversal before credit, unknown users, test_ postbacks', async () => {
  const c = client();
  await c('/api/signup', { method: 'POST', body: { email: 'frank@example.com', password: 'long enough password', ageConfirmed: true } });
  const id = (await c('/api/me')).json.user.id;
  assert.equal(await pb(gen('tx_rb', id, '50', 2).postback), 200);
  assert.equal(await pb(gen('tx_rb', id, '50', 1).postback), 200);
  assert.equal(await pb(gen('tx_unknown', 99999, '50', 1).postback), 200);
  assert.equal(await pb(gen('tx_name', 'test_user', '50', 1).postback), 200);
  assert.equal(await pb(gen('test_abc', id, '50', 1).postback), 200);
  assert.equal((await c('/api/me')).json.balance, '0');
  assert.ok(logs.some((l) => l.msg.includes('test postback')));
});

test('postbacks: tampered, wrongly signed, repeated and malformed are refused', async () => {
  const url = gen('tx_t', 1, '150', 1).postback;
  assert.equal(await pb(url.replace('reward=150', 'reward=1500')), 403);
  assert.equal(await pb(url.replace('user=1', 'user=2')), 403);
  assert.equal(await pb(url.replace(/hash=\w+/, 'hash=00')), 403);
  assert.equal(await pb(gen('tx_t', 1, '150', 1, 'other_key').postback), 403);
  assert.equal(await pb(url + '&tx=tx_other'), 403);
  assert.equal(await pb('/moonetix/postback'), 403);
  assert.equal((await fetch(base + pathOf(url), { method: 'POST' })).status, 405);
  // Moonetix never sends these values. They are signed locally to check the second line of defense.
  assert.equal(await pb(gen('tx_t', 1, '1e5', 1, KEY, { local: true }).postback), 400);
  assert.equal(await pb(gen('tx_t', 1, '150', 3).postback), 400);
});

test('static app: security headers, SPA fallback, no path traversal', async () => {
  const r = await fetch(base + '/some/page');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-src https:\/\/wall\.moonetix\.com/);
  const t = await fetch(base + '/..%2f..%2fetc%2fpasswd');
  assert.ok(!(await t.text()).includes('root:'));
});
