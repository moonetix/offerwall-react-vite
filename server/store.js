// SQLite storage with node:sqlite (built into Node.js 22.13 and later). Swap in your own database:
// the postback logic only needs applyPostback() to be one transaction with a unique transaction_id.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    balance_micro INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  -- One row per Moonetix transaction. The primary key makes a second credit impossible.
  CREATE TABLE IF NOT EXISTS reward_tx (
    transaction_id TEXT PRIMARY KEY,
    user_id        INTEGER NOT NULL,
    reward_micro   INTEGER NOT NULL,
    status         INTEGER NOT NULL CHECK (status IN (1, 2)),
    offer_name     TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reward_tx_user ON reward_tx (user_id, updated_at);
`;

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const now = () => Math.floor(Date.now() / 1000);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const q = {
    insertUser: db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'),
    userByEmail: db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, balance_micro FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    getTx: db.prepare('SELECT user_id, reward_micro, status FROM reward_tx WHERE transaction_id = ?'),
    insertTx: db.prepare(`INSERT INTO reward_tx (transaction_id, user_id, reward_micro, status, offer_name, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`),
    markReversed: db.prepare('UPDATE reward_tx SET status = 2, updated_at = ? WHERE transaction_id = ? AND status = 1'),
    addBalance: db.prepare('UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?'),
    history: db.prepare(`SELECT transaction_id, reward_micro, status, offer_name, created_at, updated_at
                         FROM reward_tx WHERE user_id = ? AND reward_micro > 0
                         ORDER BY updated_at DESC, rowid DESC LIMIT ?`),
  };

  return {
    createUser(email, passwordHash) {
      return Number(q.insertUser.run(email, passwordHash, now()).lastInsertRowid);
    },
    userByEmail: (email) => q.userByEmail.get(email),
    userById: (id) => q.userById.get(id),
    createSession: (hash, userId, ttlSeconds) => q.insertSession.run(hash, userId, now() + ttlSeconds),
    sessionUser: (hash) => q.session.get(hash, now())?.user_id ?? null,
    deleteSession: (hash) => q.deleteSession.run(hash),
    history: (userId, limit = 50) => q.history.all(userId, limit),

    /**
     * Applies one verified postback in one transaction. Returns:
     * credited, reversed, duplicate, unknown_user, or not_credited (a reversal of a transaction
     * we never credited: stored with amount 0, so a late copy of the credit cannot pay).
     */
    applyPostback({ transactionId, userId, rewardMicro, status, offerName = '' }) {
      return transaction(() => {
        const existing = q.getTx.get(transactionId);
        const t = now();
        if (status === 1) {
          if (existing) return 'duplicate';
          if (!q.userById.get(userId)) return 'unknown_user';
          q.insertTx.run(transactionId, userId, rewardMicro, 1, offerName, t, t);
          q.addBalance.run(rewardMicro, userId);
          return 'credited';
        }
        if (!existing) {
          q.insertTx.run(transactionId, userId, 0, 2, offerName, t, t);
          return 'not_credited';
        }
        if (existing.status === 2) return 'duplicate';
        q.markReversed.run(t, transactionId);
        // Take back exactly what was credited, from the user who got it.
        q.addBalance.run(-existing.reward_micro, existing.user_id);
        return 'reversed';
      });
    },
    close: () => db.close(),
  };
}
