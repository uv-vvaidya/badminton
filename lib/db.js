'use strict';
const { Pool } = require('pg');

// DATABASE_URL is preferred. PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT also work (pg reads them itself).
const url = (process.env.DATABASE_URL || '').trim();
const hasPgVars = !!(process.env.PGHOST && process.env.PGUSER);
if (!url && !hasPgVars) {
  const seen = Object.keys(process.env).filter((k) => /DATABASE|^PG|POSTGRES/i.test(k));
  console.error('DATABASE_URL is not set (or is empty) on this service.');
  console.error('Database-related variables this service can see: ' + (seen.length ? seen.join(', ') : 'none'));
  console.error('Fix: on the APP service (not Postgres) open Variables, add DATABASE_URL and pick Postgres -> DATABASE_URL from the ${{ dropdown, then click Deploy.');
  process.exit(1);
}
if (url && !/^postgres(ql)?:\/\//.test(url)) {
  console.error('DATABASE_URL does not look like a Postgres URL (it should start with postgresql://). Check the variable reference.');
  process.exit(1);
}

// Railway's private network (postgres.railway.internal) needs no TLS. Set PGSSL=true for a public/proxied URL.
const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: process.env.PGSSL_STRICT === 'true' } : false;
const pool = new Pool({ ...(url ? { connectionString: url } : {}), ssl, max: 10, connectionTimeoutMillis: 10000 });
// If Postgres restarts while the app is running, idle connections drop. Log it instead of crashing;
// the pool reconnects on the next query.
pool.on('error', (e) => console.warn('Database connection dropped (will reconnect):', e.code || e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  mime text NOT NULL,
  data bytea NOT NULL,
  private boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS teams (
  id serial PRIMARY KEY,
  event_key text NOT NULL,
  names jsonb NOT NULL DEFAULT '[]',
  reg_ids jsonb NOT NULL DEFAULT '[]',
  grp text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS registrations (
  id serial PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  mobile text NOT NULL,
  category text NOT NULL,
  event text NOT NULL,
  event_key text NOT NULL,
  has_partner boolean NOT NULL DEFAULT false,
  partner_name text NOT NULL DEFAULT '',
  partner_mobile text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  photo_id uuid,
  payment_id uuid,
  status text NOT NULL DEFAULT 'pending',
  team_id int REFERENCES teams(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS matches (
  id serial PRIMARY KEY,
  event_key text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('league','knockout')),
  grp text NOT NULL DEFAULT '',
  round int NOT NULL DEFAULT 0,
  round_name text NOT NULL DEFAULT '',
  slot int NOT NULL DEFAULT 0,
  team_a int REFERENCES teams(id) ON DELETE SET NULL,
  team_b int REFERENCES teams(id) ON DELETE SET NULL,
  court text NOT NULL DEFAULT '',
  start_time text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'scheduled',
  games jsonb NOT NULL DEFAULT '[]',
  history jsonb NOT NULL DEFAULT '[]',
  winner int,
  server int,
  points int NOT NULL DEFAULT 21,
  best_of int NOT NULL DEFAULT 1,
  cap int NOT NULL DEFAULT 30,
  next_match_id int REFERENCES matches(id) ON DELETE SET NULL,
  next_slot text,
  seq int NOT NULL DEFAULT 0,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_event_idx ON matches(event_key, stage);
CREATE INDEX IF NOT EXISTS regs_event_idx ON registrations(event_key);
-- v2: scorer and umpire roles, match officials, walkover/retired results
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','scorer','umpire'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS umpire_id int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS scored_by int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS result_note text NOT NULL DEFAULT '';
-- v3: page views and unique visitors (anonymous random browser id, no personal data)
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS amount_due int;
-- v4: daily practice poll. One vote per player (by registered mobile) per practice day.
CREATE TABLE IF NOT EXISTS practice_votes (
  day date NOT NULL,
  voter text NOT NULL,
  reg_id int,
  name text NOT NULL,
  vote text NOT NULL CHECK (vote IN ('yes','no')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, voter)
);
-- v5: the practice poll has its own voter list, managed by admins (not tournament registrations)
CREATE TABLE IF NOT EXISTS poll_members (
  id serial PRIMARY KEY,
  name text NOT NULL,
  mobile text UNIQUE NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
DELETE FROM practice_votes WHERE voter !~ '^m[0-9]+$';
CREATE TABLE IF NOT EXISTS page_views (day date PRIMARY KEY, views int NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS visitors (id text PRIMARY KEY, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now());
`;

// The database can still be starting when the app boots (or while Postgres restarts), so retry for ~4 minutes.
async function waitForDb(attempts = 30) {
  for (let i = 1; ; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch (e) {
      const host = (() => { try { return url ? new URL(url).hostname : process.env.PGHOST; } catch { return '?'; } })();
      console.warn(`Database not reachable at ${host} (attempt ${i}/${attempts}): ${e.code || e.message}`);
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, Math.min(10000, 2000 * i)));
    }
  }
}

async function migrate() {
  await waitForDb();
  await pool.query(SCHEMA);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, migrate, tx, q: (text, params) => pool.query(text, params) };
