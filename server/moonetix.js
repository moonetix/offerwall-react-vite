// Moonetix helpers for the server. Never import this file from src/: it handles secrets.
// Formats: https://docs.moonetix.com/offerwall-link and https://docs.moonetix.com/postbacks

import crypto from 'node:crypto';

export const WALL_BASE = 'https://wall.moonetix.com/';
export const USER_ID_RE = /^[A-Za-z0-9._@:+-]{1,100}$/;
const SUB_ID_RE = /^[A-Za-z0-9._~:@+-]{1,100}$/;
const AMOUNT_RE = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

/** One coin is 1,000,000 micro units. Integers keep balances exact. */
export const MICRO = 1_000_000;

/** Builds the signed offerwall link for one of your user IDs. */
export function buildWallLink({ appId, linkSalt, userId, subs = {} }) {
  const uid = String(userId);
  if (!appId || !linkSalt) throw new Error('MOONETIX_APP_ID and MOONETIX_LINK_SALT must be set');
  if (!USER_ID_RE.test(uid)) throw new Error('user ID not accepted by the offerwall');
  const hash = crypto.createHmac('sha256', linkSalt).update(uid).digest('hex');
  let url = `${WALL_BASE}${encodeURIComponent(appId)}?user_id=${encodeURIComponent(uid)}&hash=${hash}`;
  for (const [key, value] of Object.entries(subs)) {
    if (/^sub[1-5]$/.test(key) && SUB_ID_RE.test(String(value))) url += `&${key}=${encodeURIComponent(String(value))}`;
  }
  return url;
}

export function postbackHash(postbackKey, tx, user, reward, status) {
  return crypto.createHmac('sha256', postbackKey).update(`${tx}:${user}:${reward}:${status}`).digest('hex');
}

/** Constant-time comparison. Different lengths return false instead of throwing. */
export function safeEqual(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Each signed parameter must arrive exactly once. ?tx=a&tx=b returns null. */
export function readPostback(searchParams) {
  const p = {};
  for (const key of ['tx', 'user', 'reward', 'status', 'hash']) {
    const values = searchParams.getAll(key);
    if (values.length !== 1) return null;
    p[key] = values[0];
  }
  return p;
}

/** "150" -> 150000000, "0.375" -> 375000, anything else -> null. No floating point. */
export function parseAmount(value) {
  const m = AMOUNT_RE.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * MICRO + Number((m[2] || '').padEnd(6, '0'));
}

/** 150375000 -> "150.375" */
export function formatAmount(micro) {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  const frac = String(abs % MICRO).padStart(6, '0').replace(/0+$/, '');
  return sign + Math.floor(abs / MICRO) + (frac ? '.' + frac : '');
}
