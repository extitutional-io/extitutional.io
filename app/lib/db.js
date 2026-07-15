// postgres data layer — all sql lives here. async throughout; server awaits
// `ready` (schema + seed) at boot. works against any DATABASE_URL (neon,
// prisma postgres, supabase, docker).
import pg from 'pg';

// int8 (bigint) comes back as string by default — block numbers are safe as JS numbers
pg.types.setTypeParser(20, v => parseInt(v, 10));

const url = process.env.DATABASE_URL || 'postgres://postgres:qf@localhost:5455/grants';
const local = /localhost|127\.0\.0\.1/.test(url);
export const pool = new pg.Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10,       // serverless: keep the pool tiny per instance
  idleTimeoutMillis: 20000,
});

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0] ?? null;
const all = async (text, params) => (await q(text, params)).rows;

async function init() {
  await q(`
CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  matching_pool_eth DOUBLE PRECISION NOT NULL,
  match_cap_fraction DOUBLE PRECISION NOT NULL DEFAULT 0.20,
  min_donation_eth DOUBLE PRECISION NOT NULL DEFAULT 0.001,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  start_block BIGINT NOT NULL,
  end_block BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS grants (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description_md TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  website TEXT,
  twitter TEXT,
  payout_address TEXT,
  owner_contact TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS donations (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_time TIMESTAMPTZ,
  donor TEXT NOT NULL,
  dest TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  amount_eth DOUBLE PRECISION NOT NULL,
  grant_id INTEGER REFERENCES grants(id),
  round_id INTEGER REFERENCES rounds(id),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_donations_grant ON donations(grant_id);
CREATE INDEX IF NOT EXISTS idx_donations_round ON donations(round_id);
CREATE TABLE IF NOT EXISTS updates (
  id SERIAL PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES grants(id),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);`);
  await seedIfEmpty();
}
export const ready = init();

/* ---------------- meta ---------------- */
export const getMeta = async k => (await one('SELECT value FROM meta WHERE key=$1', [k]))?.value ?? null;
export const setMeta = (k, v) =>
  q('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=excluded.value', [k, String(v)]);

// atomically claim the "next index pass" slot (serverless-safe throttle).
// returns true for exactly one caller per interval.
export async function claimIndexSlot(nowMs, minIntervalMs) {
  const r = await q(`
    INSERT INTO meta(key,value) VALUES('last_index_at',$1)
    ON CONFLICT (key) DO UPDATE SET value=$1
    WHERE meta.value::bigint < $2
    RETURNING key`, [String(nowMs), String(nowMs - minIntervalMs)]);
  return r.rowCount > 0;
}

/* ---------------- rounds ---------------- */
export const activeRound = () => one('SELECT * FROM rounds ORDER BY id DESC LIMIT 1');
export const roundBySlug = slug => one('SELECT * FROM rounds WHERE slug=$1', [slug]);

/* ---------------- grants ---------------- */
export const approvedGrants = roundId =>
  all("SELECT * FROM grants WHERE round_id=$1 AND status='approved' ORDER BY id", [roundId]);

export const listGrants = (roundId, { q: query, category } = {}) => {
  let sql = "SELECT * FROM grants WHERE round_id=$1 AND status='approved'";
  const args = [roundId];
  if (query) { args.push(`%${query}%`); sql += ` AND (name ILIKE $${args.length} OR tagline ILIKE $${args.length} OR description_md ILIKE $${args.length})`; }
  if (category) { args.push(category); sql += ` AND category=$${args.length}`; }
  return all(sql + ' ORDER BY id', args);
};

export const grantBySlug = slug => one('SELECT * FROM grants WHERE slug=$1', [slug]);
export const grantById = id => one('SELECT * FROM grants WHERE id=$1', [id]);
export const pendingGrants = () => all("SELECT * FROM grants WHERE status='pending' ORDER BY created_at");
export const grantCategories = async roundId =>
  (await all("SELECT DISTINCT category FROM grants WHERE round_id=$1 AND status='approved' ORDER BY category", [roundId])).map(r => r.category);

export async function createGrant(g) {
  const base = slugify(g.name);
  let slug = base, i = 2;
  while (await grantBySlug(slug)) slug = `${base}-${i++}`;
  return q(`INSERT INTO grants (slug, round_id, name, tagline, description_md, category, website, twitter, payout_address, owner_contact, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
    [slug, g.round_id, g.name, g.tagline, g.description_md ?? '', g.category ?? 'other',
     g.website ?? null, g.twitter ?? null, g.payout_address ?? null, g.owner_contact ?? null]);
}

export const setGrantStatus = (id, status) => q('UPDATE grants SET status=$1 WHERE id=$2', [status, id]);
export const setGrantPayout = (id, addr) => q('UPDATE grants SET payout_address=$1 WHERE id=$2', [addr, id]);

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'grant';
}

/* ---------------- donations ---------------- */
export async function insertDonation(d) {
  const r = await q(`INSERT INTO donations
    (tx_hash, log_index, block_number, block_time, donor, dest, amount_wei, amount_eth, grant_id, round_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [d.tx_hash, d.log_index, d.block_number, d.block_time, d.donor, d.dest, d.amount_wei, d.amount_eth, d.grant_id, d.round_id]);
  return { changes: r.rowCount };
}

export const donationsForRound = roundId =>
  all('SELECT * FROM donations WHERE round_id=$1 ORDER BY block_number', [roundId]);

export const donationsForGrant = (grantId, limit = 50) =>
  all('SELECT * FROM donations WHERE grant_id=$1 ORDER BY block_number DESC LIMIT $2', [grantId, limit]);

export const roundTotals = roundId => one(`
  SELECT COALESCE(SUM(amount_eth),0)::float AS raised, COUNT(DISTINCT donor)::int AS donors, COUNT(*)::int AS donations
  FROM donations WHERE round_id=$1`, [roundId]);

export const grantTotals = grantId => one(`
  SELECT COALESCE(SUM(amount_eth),0)::float AS raised, COUNT(DISTINCT donor)::int AS donors, COUNT(*)::int AS donations
  FROM donations WHERE grant_id=$1`, [grantId]);

export const dailyDonations = roundId => all(`
  SELECT to_char(block_time,'YYYY-MM-DD') AS day, SUM(amount_eth)::float AS eth, COUNT(*)::int AS n
  FROM donations WHERE round_id=$1 AND block_time IS NOT NULL
  GROUP BY day ORDER BY day`, [roundId]);

/* ---------------- updates / feed ---------------- */
export const createUpdate = (grantId, title, body) =>
  q('INSERT INTO updates (grant_id, title, body_md) VALUES ($1,$2,$3)', [grantId, title, body]);

export const updatesForGrant = grantId =>
  all('SELECT * FROM updates WHERE grant_id=$1 ORDER BY created_at DESC', [grantId]);

export const feedItems = (roundId, limit = 60) => all(`
  SELECT * FROM (
    SELECT 'donation' AS kind, d.block_time AS at, g.name AS grant_name, g.slug AS grant_slug,
           d.amount_eth AS eth, d.donor AS who, NULL::text AS title
    FROM donations d JOIN grants g ON g.id = d.grant_id WHERE d.round_id = $1
    UNION ALL
    SELECT 'grant', g.created_at, g.name, g.slug, NULL::float, NULL::text, g.tagline
    FROM grants g WHERE g.round_id = $1 AND g.status='approved'
    UNION ALL
    SELECT 'update', u.created_at, g.name, g.slug, NULL::float, NULL::text, u.title
    FROM updates u JOIN grants g ON g.id = u.grant_id WHERE g.round_id = $1
  ) t ORDER BY at DESC NULLS LAST LIMIT $2`, [roundId, limit]);

export async function updateRound(id, f) {
  return q(`UPDATE rounds SET name=$1, description=$2, matching_pool_eth=$3, match_cap_fraction=$4,
    min_donation_eth=$5, start_at=$6, end_at=$7, start_block=$8, end_block=$9 WHERE id=$10`,
    [f.name, f.description, f.matching_pool_eth, f.match_cap_fraction,
     f.min_donation_eth, f.start_at, f.end_at, f.start_block, f.end_block, id]);
}
export const resetCursor = roundId => q('DELETE FROM meta WHERE key=$1', ['cursor:' + roundId]);

/* ---------------- seed ----------------
   bootstrap only: one blank round so the app has something to render.
   everything about it — and every grant — is managed from /admin. */
export async function seedIfEmpty() {
  if (await activeRound()) return;
  let startBlock = 0;
  try { startBlock = await (await import('./chain.js')).latestBlock(); } catch { /* operator sets it in admin */ }
  await q(`INSERT INTO rounds (slug, name, description, matching_pool_eth, match_cap_fraction, min_donation_eth, start_at, end_at, start_block)
    VALUES ('round-01', 'round 01', '', 0, 0.20, 0.001, now(), now() + interval '30 days', $1)`, [startBlock]);
}
