/**
 * auth.js — username/password auth with session tokens.
 *
 * - Users + sessions live in the same libsql database as Mastra memory.
 * - Passwords are hashed with scrypt (node:crypto) — never stored plain.
 * - Sessions are random 256-bit tokens delivered as httpOnly cookies.
 * - Each user's Mastra memory is scoped to resource `user-<id>`, so working
 *   memory, semantic recall, and threads are private per account.
 */

import { createClient } from '@libsql/client';
import crypto from 'node:crypto';

const db = createClient({ url: 'file:./mastra-memory.db' });

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

let ready;
function init() {
  if (!ready) {
    ready = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS app_users (
        id         TEXT PRIMARY KEY,
        username   TEXT UNIQUE NOT NULL COLLATE NOCASE,
        pass_hash  TEXT NOT NULL,
        salt       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS app_sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
    })();
  }
  return ready;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.execute({
    sql: 'INSERT INTO app_sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    args: [token, userId, Date.now() + SESSION_TTL_MS],
  });
  return token;
}

export async function signup(username, password) {
  await init();
  username = String(username || '').trim();
  password = String(password || '');
  if (username.length < 2) throw new Error('Username must be at least 2 characters.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new Error('Username may only contain letters, numbers, _ . -');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');

  const existing = await db.execute({ sql: 'SELECT id FROM app_users WHERE username = ?', args: [username] });
  if (existing.rows.length > 0) throw new Error('That username is already taken.');

  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  await db.execute({
    sql: 'INSERT INTO app_users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [id, username, hashPassword(password, salt), salt, Date.now()],
  });

  const token = await createSession(id);
  return { user: { id, username }, token };
}

export async function signin(username, password) {
  await init();
  username = String(username || '').trim();
  const res = await db.execute({ sql: 'SELECT * FROM app_users WHERE username = ?', args: [username] });
  const row = res.rows[0];
  if (!row) throw new Error('Invalid username or password.');

  const candidate = Buffer.from(hashPassword(String(password || ''), row.salt), 'hex');
  const actual = Buffer.from(row.pass_hash, 'hex');
  if (candidate.length !== actual.length || !crypto.timingSafeEqual(candidate, actual)) {
    throw new Error('Invalid username or password.');
  }

  const token = await createSession(row.id);
  return { user: { id: row.id, username: row.username }, token };
}

export async function getUserByToken(token) {
  if (!token) return null;
  await init();
  const res = await db.execute({
    sql: `SELECT u.id, u.username FROM app_sessions s
          JOIN app_users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, Date.now()],
  });
  return res.rows[0] ? { id: res.rows[0].id, username: res.rows[0].username } : null;
}

export async function signout(token) {
  if (!token) return;
  await init();
  await db.execute({ sql: 'DELETE FROM app_sessions WHERE token = ?', args: [token] });
}

/** Read the session token from a request (cookie or Authorization header). */
export function tokenFromRequest(req) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)crag_session=([a-f0-9]+)/);
  return m ? m[1] : null;
}

/** The Mastra memory resource ID for a user — scopes all memory per account. */
export function resourceIdFor(user) {
  return `user-${user.id}`;
}
