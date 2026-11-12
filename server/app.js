// HTTP routes. node:http only, no framework.
//   POST /api/signup, /api/login, /api/logout   accounts (JSON)
//   GET  /api/me                                 user, balance and reward history
//   GET  /api/offerwall-link                     signed offerwall link of the signed-in user
//   GET  /moonetix/postback                      Moonetix postbacks (credits and reversals)
//   everything else                              the built React app from dist/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  DUMMY_HASH, SESSION_TTL, hashPassword, newSessionToken, rateLimiter, readCookie, sessionCookie, tokenHash, verifyPassword,
} from './auth.js';
import { buildWallLink, formatAmount, parseAmount, postbackHash, readPostback, safeEqual } from './moonetix.js';

const COOKIE = 'sid';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
// The offerwall is the only third party: embed.js (script) and the wall itself (frame).
const CSP = [
  "default-src 'self'", "script-src 'self' https://wall.moonetix.com", "frame-src https://wall.moonetix.com",
  "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function createApp(config) {
  const { store, appId, linkSalt, postbackKey, creditTestPostbacks = false, secureCookies = false, staticDir = null } = config;
  const log = config.log ?? ((level, msg, data) => console[level](msg, data ?? ''));
  const authLimit = rateLimiter({ max: config.loginAttempts ?? 10, windowMs: 15 * 60 * 1000 });
  const signupLimit = rateLimiter({ max: config.signupsPerHour ?? 5, windowMs: 60 * 60 * 1000 });

  function send(res, status, body, headers = {}) {
    const isJson = body !== null && typeof body === 'object';
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body ?? undefined);
  }

  function currentUserId(req) {
    const token = readCookie(req.headers.cookie, COOKIE);
    return token ? store.sessionUser(tokenHash(token)) : null;
  }

  async function readJson(req) {
    // A cross-site HTML form cannot send application/json without a CORS preflight, which we never allow.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return null;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return null;
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) return null;
    }
    try {
      const body = JSON.parse(raw);
      return body && typeof body === 'object' ? body : null;
    } catch {
      return null;
    }
  }

  function startSession(res, userId) {
    const token = newSessionToken();
    store.createSession(tokenHash(token), userId, SESSION_TTL);
    return { 'Set-Cookie': sessionCookie(COOKIE, token, { secure: secureCookies, maxAge: SESSION_TTL }) };
  }

  const ip = (req) => req.socket.remoteAddress || 'unknown';

  async function signup(req, res) {
    if (!signupLimit(ip(req))) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'Bad request.' });
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 200) return send(res, 400, { error: 'Use a password of 10 to 200 characters.' });
    if (body.ageConfirmed !== true) return send(res, 400, { error: 'You must be 16 or older to earn rewards.' });
    if (store.userByEmail(email)) return send(res, 409, { error: 'An account with this email already exists.' });
    let id;
    try {
      id = store.createUser(email, hashPassword(password));
    } catch {
      return send(res, 409, { error: 'An account with this email already exists.' });
    }
    return send(res, 201, { ok: true }, startSession(res, id));
  }

  async function login(req, res) {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'Bad request.' });
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!authLimit(`login:${ip(req)}`) || !authLimit(`login:${email}`)) {
      return send(res, 429, { error: 'Too many attempts. Try again later.' });
    }
    const user = store.userByEmail(email);
    const ok = verifyPassword(String(body.password ?? ''), user?.password_hash ?? DUMMY_HASH) && !!user;
    if (!ok) return send(res, 401, { error: 'Wrong email or password.' });
    return send(res, 200, { ok: true }, startSession(res, user.id));
  }

  async function logout(req, res) {
    if (!(await readJson(req))) return send(res, 400, { error: 'Bad request.' });
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token) store.deleteSession(tokenHash(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(COOKIE, '', { secure: secureCookies, maxAge: 0 }) });
  }

  function me(req, res) {
    const userId = currentUserId(req);
    const user = userId && store.userById(userId);
    if (!user) return send(res, 401, { error: 'Not signed in.' });
    const history = store.history(user.id).map((r) => ({
      id: r.transaction_id,
      offer: r.offer_name,
      amount: formatAmount(r.reward_micro),
      state: r.status === 1 ? 'credited' : 'reversed',
      at: r.updated_at,
    }));
    return send(res, 200, { user: { id: user.id, email: user.email }, balance: formatAmount(user.balance_micro), history });
  }

  function offerwallLink(req, res) {
    // The user comes from the session cookie. A user ID in the query or body is never read.
    const userId = currentUserId(req);
    if (!userId) return send(res, 401, { error: 'Not signed in.' });
    try {
      return send(res, 200, { url: buildWallLink({ appId, linkSalt, userId, subs: { sub1: 'react_vite' } }) }, {
        'Cache-Control': 'private, no-store',
      });
    } catch (err) {
      log('error', 'moonetix: cannot build the offerwall link', { error: err.message });
      return send(res, 500, { error: 'Offerwall not configured.' });
    }
  }

  function postback(req, res, url) {
    if (req.method !== 'GET') return send(res, 405, null);
    // 1. Hash first, on the values exactly as they arrived.
    const p = readPostback(url.searchParams);
    if (!p) return send(res, 403, null);
    if (!postbackKey) {
      log('error', 'moonetix: MOONETIX_POSTBACK_KEY is not set');
      return send(res, 500, null);
    }
    if (!safeEqual(p.hash, postbackHash(postbackKey, p.tx, p.user, p.reward, p.status))) return send(res, 403, null);

    // 2. Signed values that make no sense: a retry would not fix them.
    const rewardMicro = parseAmount(p.reward);
    if (rewardMicro === null || (p.status !== '1' && p.status !== '2') || p.tx === '' || p.tx.length > 255) {
      log('warn', 'moonetix: postback with unexpected values', { tx: p.tx, status: p.status, reward: p.reward });
      return send(res, 400, null);
    }
    // 3. Dashboard tests (transaction ID test_...) are logged only, unless you opt in.
    if (p.tx.startsWith('test_') && !creditTestPostbacks) {
      log('info', 'moonetix: test postback (not credited)', { tx: p.tx, user: p.user, status: p.status });
      return send(res, 200, null);
    }
    // 4. Our user IDs are positive integers. Anything else is not one of our users.
    if (!/^[1-9]\d{0,14}$/.test(p.user)) {
      log('warn', 'moonetix: postback for an unknown user ID, ignored', { tx: p.tx, user: p.user });
      return send(res, 200, null);
    }
    // 5. Store, then answer. 500 makes Moonetix retry later.
    try {
      const offer = url.searchParams.get('offer') ?? '';
      const result = store.applyPostback({
        transactionId: p.tx, userId: Number(p.user), rewardMicro, status: Number(p.status), offerName: offer.slice(0, 200),
      });
      log('info', 'moonetix: postback', { tx: p.tx, status: p.status, result });
      return send(res, 200, null);
    } catch (err) {
      log('error', 'moonetix: postback failed', { tx: p.tx, error: err.message });
      return send(res, 500, null);
    }
  }

  function serveStatic(req, res, url) {
    if (!staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, { error: 'Not found.' });
    const root = path.resolve(staticDir);
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) return send(res, 404, null);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // single-page app
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Run npm run build first.' });
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, null);
    }
    try {
      const route = `${req.method} ${url.pathname}`;
      if (url.pathname === '/moonetix/postback') return postback(req, res, url);
      if (route === 'POST /api/signup') return await signup(req, res);
      if (route === 'POST /api/login') return await login(req, res);
      if (route === 'POST /api/logout') return await logout(req, res);
      if (route === 'GET /api/me') return me(req, res);
      if (route === 'GET /api/offerwall-link') return offerwallLink(req, res);
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
      return serveStatic(req, res, url);
    } catch (err) {
      log('error', 'request failed', { path: url.pathname, error: err.message });
      if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    }
  });
}
