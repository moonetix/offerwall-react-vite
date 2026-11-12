import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWallLink, formatAmount, parseAmount, postbackHash, readPostback, safeEqual } from '../server/moonetix.js';
import { APP, KEY, SALT, gen } from './vectors.js';

test('wall link matches the Moonetix link for the same user ID', () => {
  for (const id of [1, 42, 'a.b_c@d:e+f-g']) {
    assert.equal(buildWallLink({ appId: APP, linkSalt: SALT, userId: id }), gen('tx', id, 1, 1).wall);
  }
});

test('wall link: sub IDs outside the hash, bad user IDs and missing keys refused', () => {
  assert.equal(
    buildWallLink({ appId: APP, linkSalt: SALT, userId: 7, subs: { sub1: 'react_vite', sub2: 'no spaces', sub9: 'x' } }),
    gen('tx', 7, 1, 1).wall + '&sub1=react_vite',
  );
  assert.throws(() => buildWallLink({ appId: APP, linkSalt: SALT, userId: '' }));
  assert.throws(() => buildWallLink({ appId: APP, linkSalt: SALT, userId: 'a b' }));
  assert.throws(() => buildWallLink({ appId: APP, linkSalt: '', userId: 1 }));
});

test('postback hash equals the Moonetix hash', () => {
  for (const [reward, status] of [['150', 1], ['0.375', 2], ['1.23456', 1]]) {
    const p = readPostback(new URL(gen('tx_h', 42, reward, status).postback).searchParams);
    assert.equal(p.reward, reward);
    assert.ok(safeEqual(p.hash, postbackHash(KEY, p.tx, p.user, p.reward, p.status)));
  }
});

test('readPostback wants every signed parameter exactly once', () => {
  const url = gen('tx_1', 1, 5, 1).postback;
  assert.ok(readPostback(new URL(url).searchParams));
  assert.equal(readPostback(new URL(url + '&user=2').searchParams), null);
  assert.equal(readPostback(new URL(url.replace(/&hash=\w+/, '')).searchParams), null);
});

test('amounts are exact integers', () => {
  assert.equal(parseAmount('150'), 150_000_000);
  assert.equal(parseAmount('0.375'), 375_000);
  for (const bad of ['', '-1', '1e2', '.5', '1.', '1,5', '1.1234567']) assert.equal(parseAmount(bad), null, bad);
  assert.equal(formatAmount(parseAmount('0.1') + parseAmount('0.2')), '0.3');
  assert.equal(formatAmount(-1_500_000), '-1.5');
});
