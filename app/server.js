import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/db.js';
import { computeRound } from './lib/qf.js';
import { startIndexer, indexRound, maybeIndex } from './lib/indexer.js';
import { layout, fmtEth, shortAddr, timeAgo } from './lib/html.js';
import { md, esc } from './lib/md.js';
import { ogPng } from './lib/og.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const SERVERLESS = !!process.env.VERCEL;
const PORT = Number(process.env.PORT || 4870);

await store.ready;   // schema + seed before first request

// admin key: env wins; otherwise generated once and persisted in the db
const ADMIN_KEY = process.env.ADMIN_KEY || await (async () => {
  let k = await store.getMeta('admin_key');
  if (!k) { k = crypto.randomBytes(12).toString('hex'); await store.setMeta('admin_key', k); }
  return k;
})();

// express 4 doesn't catch async errors — wrap every handler
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// absolute base url for og:image / og:url — env in prod, request host otherwise
const baseUrl = req => (process.env.BASE_URL ||
  `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${req.headers.host}`).replace(/\/$/, '');

// serverless indexing: any page view lazily triggers a chain scan (throttled
// to one pass/min across all lambdas via an atomic db claim)
if (SERVERLESS) app.use((req, res, next) => { maybeIndex().catch(() => {}); next(); });

/* ---------- round computation (memoized briefly) ---------- */
let memo = { at: 0, promise: null };
function roundData() {
  if (Date.now() - memo.at < 15000 && memo.promise) return memo.promise;
  memo = {
    at: Date.now(),
    promise: (async () => {
      const round = await store.activeRound();
      const [grants, donations, totals] = await Promise.all([
        store.approvedGrants(round.id),
        store.donationsForRound(round.id),
        store.roundTotals(round.id),
      ]);
      const { stats, matches } = computeRound(round, donations);
      const byId = {};
      for (const g of grants) {
        const key = g.payout_address ? g.payout_address.toLowerCase() : null;
        byId[g.id] = {
          raised: key && stats[key] ? stats[key].raised : 0,
          donors: key && stats[key] ? stats[key].donors : 0,
          match: key && matches[key] ? matches[key] : 0,
        };
      }
      return { round, grants, donations, totals, byId };
    })(),
  };
  memo.promise.catch(() => { memo.at = 0; });
  return memo.promise;
}
const bust = () => { memo.at = 0; };

function roundStatus(round) {
  const now = Date.now(), s = new Date(round.start_at).getTime(), e = new Date(round.end_at).getTime();
  if (now < s) return { label: 'opens ' + new Date(s).toLocaleDateString('en-US'), live: false };
  if (now > e) return { label: 'round closed · matches final', live: false };
  return { label: 'live · ' + Math.ceil((e - now) / 864e5) + 'd left', live: true };
}

/* ---------- shared fragments ---------- */
function grantCard(g, t, maxMatch) {
  const pct = maxMatch > 0 ? Math.min(100, (t.match / maxMatch) * 100) : 0;
  return `<div class="grant" data-grant-card="${g.id}">
    <span class="cat">${esc(g.category)}</span>
    <h3><a href="/grants/${esc(g.slug)}">${esc(g.name)}</a></h3>
    <p>${esc(g.tagline)}</p>
    <div class="meta">${fmtEth(t.raised)} raised · ${t.donors} contributor${t.donors === 1 ? '' : 's'} · <b>est. match ${fmtEth(t.match)}</b></div>
    <div class="track"><i style="width:${pct}%"></i></div>
    <div class="row">
      <button class="btn sm solid" data-add="${g.id}" data-name="${esc(g.name)}" ${g.payout_address ? '' : 'disabled title="payout address pending"'}>add to cart</button>
      <a class="mono" style="font-size:10px;color:var(--ink-faint);text-decoration:none" href="/grants/${esc(g.slug)}">details →</a>
    </div>
  </div>`;
}

function statRow(round, totals, nGrants) {
  return `<div class="statrow">
    <div class="stat"><div class="v">${fmtEth(round.matching_pool_eth)}</div><div class="k">matching pool</div></div>
    <div class="stat"><div class="v">${fmtEth(totals.raised)}</div><div class="k">crowdfunded</div></div>
    <div class="stat"><div class="v">${totals.donors}</div><div class="k">contributors</div></div>
    <div class="stat"><div class="v">${nGrants}</div><div class="k">projects</div></div>
  </div>`;
}

/* ================= pages ================= */

app.get('/', ah(async (req, res) => {
  const { round, grants, totals, byId } = await roundData();
  const st = roundStatus(round);
  const maxMatch = Math.max(0, ...Object.values(byId).map(t => t.match));
  const feed = await store.feedItems(round.id, 8);
  const body = `
<header class="hero"><div class="wrap">
  <span class="mono eyebrow">app 01 · quadratic funding · eth on mainnet</span>
  <h1>${esc(round.name)} <span class="statuspill ${st.live ? 'live' : ''}"><i></i>${esc(st.label)}</span></h1>
  <p class="lede">${esc(round.description)}</p>
  ${statRow(round, totals, grants.length)}
</div></header>
<section class="block"><div class="wrap">
  <span class="mono eyebrow">the projects</span>
  <h2>add several to your cart. give once.</h2>
  <p class="sub">estimated matches update as donations land on-chain. breadth is the whole game — your ten favorite projects beat one.</p>
  ${grants.length
    ? `<div class="grants">${grants.map(g => grantCard(g, byId[g.id], maxMatch)).join('')}</div>`
    : `<div class="banner" style="margin-top:26px"><b>no projects yet.</b> the round is taking applications — be one of the first in.</div>`}
  <p style="margin-top:24px"><a class="btn" href="/grants">browse all grants →</a> <a class="btn" href="/apply">apply as a project →</a></p>
</div></section>
<section class="block" style="padding-top:0"><div class="wrap">
  <span class="mono eyebrow">town square</span>
  <h2>what's happening</h2>
  <div class="feed">${feed.map(feedLine).join('') || '<div class="fitem"><span class="what">quiet so far — be the first donation.</span></div>'}</div>
  <p style="margin-top:18px"><a class="btn sm" href="/feed">full feed →</a></p>
</div></section>`;
  res.send(layout({
    title: round.name + ' · quadratic funding',
    desc: round.description,
    url: baseUrl(req) + '/',
    image: baseUrl(req) + '/og/round.png',
  }, body, { active: '' }));
}));

app.get('/grants', ah(async (req, res) => {
  const { round, byId } = await roundData();
  const q = (req.query.q || '').toString().slice(0, 80);
  const category = (req.query.category || '').toString().slice(0, 40);
  const [grants, cats] = await Promise.all([
    store.listGrants(round.id, { q, category }),
    store.grantCategories(round.id),
  ]);
  const maxMatch = Math.max(0, ...Object.values(byId).map(t => t.match));
  const body = `
<header class="hero"><div class="wrap">
  <a class="backlink mono" href="/">← ${esc(round.name)}</a><br><br>
  <span class="mono eyebrow">grant directory</span>
  <h1>every project in the round.</h1>
  <form class="filters" method="get" action="/grants">
    <input type="text" name="q" placeholder="search grants…" value="${esc(q)}">
    <button class="btn sm" type="submit">search</button>
    <a class="chip ${!category ? 'on' : ''}" href="/grants${q ? '?q=' + encodeURIComponent(q) : ''}">all</a>
    ${cats.map(c => `<a class="chip ${c === category ? 'on' : ''}" href="/grants?category=${encodeURIComponent(c)}${q ? '&q=' + encodeURIComponent(q) : ''}">${esc(c)}</a>`).join('')}
  </form>
</div></header>
<section class="block"><div class="wrap">
  <p class="sub">${grants.length} project${grants.length === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}${category ? ` in ${esc(category)}` : ''}</p>
  <div class="grants">${grants.map(g => grantCard(g, byId[g.id] || { raised: 0, donors: 0, match: 0 }, maxMatch)).join('') || '<p class="sub">nothing found.</p>'}</div>
</div></section>`;
  res.send(layout({
    title: 'grants · ' + round.name,
    desc: 'browse every project in ' + round.name + ' — quadratic funding on ethereum mainnet.',
    url: baseUrl(req) + '/grants',
    image: baseUrl(req) + '/og/round.png',
  }, body, { active: 'grants' }));
}));

app.get('/grants/:slug', ah(async (req, res) => {
  const g = await store.grantBySlug(req.params.slug);
  if (!g || g.status !== 'approved') return res.status(404).send(layout({ title: 'not found' }, `<section class="block"><div class="wrap"><h1>no such grant</h1><p class="lede"><a href="/grants">← back to the directory</a></p></div></section>`));
  const { round, byId } = await roundData();
  const t = byId[g.id] || { raised: 0, donors: 0, match: 0 };
  const [dons, ups] = await Promise.all([
    store.donationsForGrant(g.id, 25),
    store.updatesForGrant(g.id),
  ]);
  const pageUrl = `${baseUrl(req)}/grants/${g.slug}`;
  const shareText = `back "${g.name}" in ${round.name} — every donation moves matching money. breadth beats depth 🍄`;
  const body = `
<header class="hero"><div class="wrap">
  <a class="backlink mono" href="/grants">← all grants</a><br><br>
  <span class="mono eyebrow">${esc(g.category)}</span>
  <h1>${esc(g.name)}</h1>
  <p class="lede">${esc(g.tagline)}</p>
  <div class="statrow">
    <div class="stat"><div class="v">${fmtEth(t.raised)}</div><div class="k">raised</div></div>
    <div class="stat"><div class="v">${t.donors}</div><div class="k">contributors</div></div>
    <div class="stat"><div class="v" style="color:var(--lime)">${fmtEth(t.match)}</div><div class="k">est. match</div></div>
    <div class="stat"><div class="v"><button class="btn sm solid" data-add="${g.id}" data-name="${esc(g.name)}" ${g.payout_address ? '' : 'disabled'}>add to cart</button></div><div class="k">${g.payout_address ? 'donate eth · matched live' : 'payout address pending'}</div></div>
  </div>
  <div class="sharebar">
    <a class="btn sm" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}">share on x</a>
    <a class="btn sm" target="_blank" rel="noopener" href="https://warpcast.com/~/compose?text=${encodeURIComponent(shareText + ' ' + pageUrl)}">cast</a>
    ${g.website ? `<a class="btn sm" href="${esc(g.website)}" target="_blank" rel="noopener nofollow">website ↗</a>` : ''}
    ${g.twitter ? `<a class="btn sm" href="https://x.com/${esc(g.twitter.replace(/^@/, ''))}" target="_blank" rel="noopener nofollow">@${esc(g.twitter.replace(/^@/, ''))}</a>` : ''}
  </div>
</div></header>
<section class="block"><div class="wrap" style="display:grid;grid-template-columns:1.6fr 1fr;gap:44px" id="detailgrid">
  <div>
    <div class="prose">${md(g.description_md)}</div>
    ${ups.length ? `<h2 style="margin-top:40px">updates</h2>` + ups.map(u => `
      <div style="border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-top:14px;background:var(--panel)">
        <div class="mono" style="font-size:10px;color:var(--ink-faint)">${timeAgo(u.created_at)}</div>
        <h3 style="font-size:17px;margin:4px 0 6px">${esc(u.title)}</h3>
        <div class="prose" style="font-size:14.5px">${md(u.body_md)}</div>
      </div>`).join('') : ''}
  </div>
  <div>
    <h2 style="font-size:20px">recent backers</h2>
    <table><thead><tr><th>donor</th><th>amount</th><th>when</th></tr></thead><tbody>
      ${dons.map(d => `<tr><td class="mono" style="font-size:11px"><a href="https://etherscan.io/address/${esc(d.donor)}" target="_blank" rel="noopener" style="text-decoration:none">${shortAddr(d.donor)}</a></td><td><b>${fmtEth(d.amount_eth)}</b></td><td class="mono" style="font-size:10px">${timeAgo(d.block_time)}</td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--ink-faint)">no donations yet — be first.</td></tr>'}
    </tbody></table>
    ${g.payout_address ? `<p class="mono" style="font-size:10px;color:var(--ink-faint);margin-top:14px">payout: <a href="https://etherscan.io/address/${esc(g.payout_address)}" target="_blank" rel="noopener">${esc(g.payout_address)}</a></p>` : ''}
  </div>
</div></section>
<style>@media(max-width:860px){#detailgrid{grid-template-columns:1fr !important}}</style>`;
  res.send(layout({
    title: g.name + ' · ' + round.name,
    desc: g.tagline,
    url: pageUrl,
    image: `${baseUrl(req)}/og/grant/${g.slug}.png`,
    type: 'article',
  }, body, { active: 'grants' }));
}));

/* ---------- apply ---------- */
const CATEGORIES = ['media · narrative', 'protocol · governance', 'community · irl', 'infra · transparency', 'education · onboarding', 'security · commons', 'other'];

app.get('/apply', ah(async (req, res) => {
  const { round } = await roundData();
  const body = `
<header class="hero"><div class="wrap">
  <span class="mono eyebrow">for grant owners</span>
  <h1>apply to ${esc(round.name)}.</h1>
  <p class="lede">get funding plus the leverage that turns small gifts into a real budget. applications are reviewed for eligibility before appearing in the round.</p>
</div></header>
<section class="block"><div class="wrap" style="max-width:640px">
  ${req.query.ok ? '<div class="banner"><b>submitted.</b> your grant is in the review queue — we\'ll be in touch at the contact you gave. </div>' : ''}
  ${req.query.err ? `<div class="banner" style="border-color:var(--red)"><b style="color:var(--red)">fix needed:</b> ${esc(req.query.err)}</div>` : ''}
  <form method="post" action="/apply">
    <label>project name *</label><input type="text" name="name" required maxlength="80">
    <label>one-line tagline *</label><input type="text" name="tagline" required maxlength="160" placeholder="what it is, why it matters — one sentence">
    <label>category</label><select name="category">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
    <label>description (markdown ok)</label><textarea name="description_md" rows="8" placeholder="## what we do&#10;- …&#10;&#10;## why it matters"></textarea>
    <label>website</label><input type="url" name="website" placeholder="https://…">
    <label>twitter / x handle</label><input type="text" name="twitter" placeholder="@yourproject" maxlength="40">
    <label>eth payout address (mainnet) *</label><input type="text" name="payout_address" required placeholder="0x…" pattern="0x[0-9a-fA-F]{40}">
    <label>contact (email or telegram) *</label><input type="text" name="owner_contact" required maxlength="120">
    <p style="margin-top:22px"><button class="btn solid" type="submit">submit for review</button></p>
    <p class="mono" style="font-size:10px;color:var(--ink-faint);margin-top:12px">donations pay out directly to your address on-chain — the platform never holds funds.</p>
  </form>
</div></section>`;
  res.send(layout({
    title: 'apply · ' + round.name,
    desc: 'list your project in ' + round.name + ' and let the crowd fund it.',
    url: baseUrl(req) + '/apply',
    image: baseUrl(req) + '/og/round.png',
  }, body, { active: 'apply' }));
}));

app.post('/apply', ah(async (req, res) => {
  const { round } = await roundData();
  const b = req.body;
  const fail = m => res.redirect('/apply?err=' + encodeURIComponent(m));
  if (!b.name?.trim() || !b.tagline?.trim()) return fail('name and tagline are required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(b.payout_address || '')) return fail('payout address must be a valid 0x… mainnet address');
  if (!b.owner_contact?.trim()) return fail('we need a contact to reach you at');
  await store.createGrant({
    round_id: round.id,
    name: b.name.trim().slice(0, 80),
    tagline: b.tagline.trim().slice(0, 160),
    description_md: (b.description_md || '').slice(0, 20000),
    category: CATEGORIES.includes(b.category) ? b.category : 'other',
    website: /^https?:\/\//.test(b.website || '') ? b.website.slice(0, 200) : null,
    twitter: (b.twitter || '').replace(/^@/, '').slice(0, 40) || null,
    payout_address: b.payout_address,
    owner_contact: b.owner_contact.trim().slice(0, 120),
  });
  res.redirect('/apply?ok=1');
}));

/* ---------- feed & stats ---------- */
function feedLine(f) {
  const link = `<a href="/grants/${esc(f.grant_slug)}">${esc(f.grant_name)}</a>`;
  const what =
    f.kind === 'donation' ? `<b>${fmtEth(f.eth)}</b> from <span class="mono" style="font-size:11px">${shortAddr(f.who)}</span> → ${link}` :
    f.kind === 'grant' ? `🌱 new grant: ${link} — ${esc(f.title || '')}` :
    `📣 ${link} posted an update: <b>${esc(f.title || '')}</b>`;
  return `<div class="fitem"><span class="when">${timeAgo(f.at) || ''}</span><div class="what">${what}</div></div>`;
}

app.get('/feed', ah(async (req, res) => {
  const { round } = await roundData();
  const feed = await store.feedItems(round.id, 100);
  const body = `
<header class="hero"><div class="wrap">
  <span class="mono eyebrow">town square</span>
  <h1>the live feed.</h1>
  <p class="lede">donations landing, grants arriving, milestones hit. the round, as it happens.</p>
</div></header>
<section class="block"><div class="wrap">
  <div class="feed">${feed.map(feedLine).join('') || '<div class="fitem"><span class="what">nothing yet.</span></div>'}</div>
</div></section>`;
  res.send(layout({
    title: 'feed · ' + round.name, desc: 'live activity in ' + round.name,
    url: baseUrl(req) + '/feed', image: baseUrl(req) + '/og/round.png',
  }, body, { active: 'feed' }));
}));

app.get('/stats', ah(async (req, res) => {
  const { round, grants, totals, byId } = await roundData();
  const daily = await store.dailyDonations(round.id);
  const maxD = Math.max(0.0001, ...daily.map(d => d.eth));
  const spark = daily.length ? `<svg class="spark" width="100%" height="90" viewBox="0 0 ${daily.length * 26} 90" preserveAspectRatio="none">
    ${daily.map((d, i) => `<rect x="${i * 26 + 3}" y="${86 - (d.eth / maxD) * 80}" width="20" height="${(d.eth / maxD) * 80 + 2}" rx="3" fill="#b8f05c" opacity=".85"><title>${d.day}: ${d.eth.toFixed(4)} ETH (${d.n})</title></rect>`).join('')}
  </svg>` : '<p class="sub">no donations yet.</p>';
  const rows = grants
    .map(g => ({ g, t: byId[g.id] || { raised: 0, donors: 0, match: 0 } }))
    .sort((a, b) => b.t.match - a.t.match);
  const body = `
<header class="hero"><div class="wrap">
  <span class="mono eyebrow">round dashboard</span>
  <h1>the numbers.</h1>
  ${statRow(round, totals, grants.length)}
</div></header>
<section class="block"><div class="wrap">
  <h2>donations per day</h2>${spark}
  <h2 style="margin-top:40px">leaderboard</h2>
  <table><thead><tr><th>#</th><th>project</th><th>raised</th><th>contributors</th><th>est. match</th></tr></thead><tbody>
  ${rows.map((r, i) => `<tr><td class="mono" style="font-size:11px">${i + 1}</td><td><b><a href="/grants/${esc(r.g.slug)}" style="text-decoration:none">${esc(r.g.name)}</a></b></td><td>${fmtEth(r.t.raised)}</td><td>${r.t.donors}</td><td><b style="color:var(--lime)">${fmtEth(r.t.match)}</b></td></tr>`).join('')}
  </tbody></table>
  <p class="mono" style="font-size:10px;color:var(--ink-faint);margin-top:16px">cap ${round.match_cap_fraction * 100}% of pool per project · min ${fmtEth(round.min_donation_eth)} per donation for matching · matches recomputed live from on-chain events</p>
</div></section>`;
  res.send(layout({
    title: 'stats · ' + round.name, desc: 'live dashboard for ' + round.name,
    url: baseUrl(req) + '/stats', image: baseUrl(req) + '/og/round.png',
  }, body, { active: 'stats' }));
}));

/* ---------- admin ---------- */
function isAdmin(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('admin='));
  return (cookie && cookie.slice(6) === ADMIN_KEY) || req.query.key === ADMIN_KEY;
}
function requireAdmin(req, res) {
  if (isAdmin(req)) {
    if (req.query.key === ADMIN_KEY) res.setHeader('Set-Cookie', `admin=${ADMIN_KEY}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
    return true;
  }
  res.status(403).send(layout({ title: 'admin' }, `<section class="block"><div class="wrap"><h1>operators only</h1><p class="lede">open <span class="mono">/admin?key=…</span> with the round operator key.</p></div></section>`));
  return false;
}

app.get('/admin', ah(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { round, grants, byId } = await roundData();
  const pending = await store.pendingGrants();
  const body = `
<header class="hero"><div class="wrap">
  <span class="mono eyebrow">round operator</span>
  <h1>keep it legitimate.</h1>
  <p class="lede">approve eligible grants, keep payout addresses right, publish updates. the round's credibility rests here.</p>
</div></header>
<section class="block"><div class="wrap">
  ${req.query.saved ? '<div class="banner"><b>round saved.</b> live pages pick it up within ~15 seconds.</div>' : ''}
  ${req.query.err ? `<div class="banner" style="border-color:var(--red)"><b style="color:var(--red)">not saved:</b> ${esc(req.query.err)}</div>` : ''}
  ${!Number(round.start_block) ? '<div class="banner" style="border-color:var(--red)"><b style="color:var(--red)">indexing paused:</b> set a start block below — donations on-chain before it are ignored, and nothing is scanned until it\'s set.</div>' : ''}
  <h2>round settings</h2>
  <form method="post" action="/admin/round" style="max-width:640px">
    <label>round name</label><input type="text" name="name" required maxlength="80" value="${esc(round.name)}">
    <label>description (shown on the home page)</label><textarea name="description" rows="3" maxlength="500">${esc(round.description)}</textarea>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
      <div><label>matching pool (eth)</label><input type="text" inputmode="decimal" name="matching_pool_eth" value="${round.matching_pool_eth}"></div>
      <div><label>per-project cap (0–1)</label><input type="text" inputmode="decimal" name="match_cap_fraction" value="${round.match_cap_fraction}"></div>
      <div><label>min donation (eth)</label><input type="text" inputmode="decimal" name="min_donation_eth" value="${round.min_donation_eth}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div><label>starts (utc)</label><input type="datetime-local" name="start_at" required value="${new Date(round.start_at).toISOString().slice(0, 16)}"></div>
      <div><label>ends (utc)</label><input type="datetime-local" name="end_at" required value="${new Date(round.end_at).toISOString().slice(0, 16)}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div><label>start block (indexer scans from here)</label><input type="text" inputmode="numeric" name="start_block" value="${round.start_block ?? ''}"></div>
      <div><label>end block (blank while live; set to freeze results)</label><input type="text" inputmode="numeric" name="end_block" value="${round.end_block ?? ''}"></div>
    </div>
    <p style="margin-top:16px"><button class="btn solid" type="submit">save round</button></p>
    <p class="mono" style="font-size:10px;color:var(--ink-faint)">lowering the start block rescans history automatically. current mainnet head ≈ <a href="https://etherscan.io/blocks" target="_blank" rel="noopener" style="color:var(--ink-dim)">etherscan</a>.</p>
  </form>

  <h2 style="margin-top:44px">approval queue (${pending.length})</h2>
  ${pending.map(g => `
  <div style="border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-top:14px;background:var(--panel)">
    <div class="mono" style="font-size:10px;color:var(--ink-faint)">${esc(g.category)} · applied ${timeAgo(g.created_at)} · contact: ${esc(g.owner_contact || '—')}</div>
    <h3 style="margin:6px 0">${esc(g.name)}</h3>
    <p style="color:var(--ink-dim);font-size:14.5px">${esc(g.tagline)}</p>
    <p class="mono" style="font-size:10px;margin:8px 0;color:var(--ink-faint)">payout: ${esc(g.payout_address || 'none')} ${g.website ? `· <a href="${esc(g.website)}" target="_blank" rel="noopener nofollow">site↗</a>` : ''}</p>
    <details style="font-size:14px;color:var(--ink-dim)"><summary class="mono" style="font-size:10px;cursor:pointer">full description</summary><div class="prose">${md(g.description_md)}</div></details>
    <div style="display:flex;gap:10px;margin-top:12px">
      <form method="post" action="/admin/grants/${g.id}/approve"><button class="btn sm solid">approve</button></form>
      <form method="post" action="/admin/grants/${g.id}/reject"><button class="btn sm" style="border-color:var(--red);color:var(--red)">reject</button></form>
    </div>
  </div>`).join('') || '<p class="sub">queue\'s empty.</p>'}

  <h2 style="margin-top:44px">approved grants (${grants.length})</h2>
  <table><thead><tr><th>grant</th><th>payout</th><th>raised</th><th>match</th><th>actions</th></tr></thead><tbody>
  ${grants.map(g => `<tr>
    <td><b><a href="/grants/${esc(g.slug)}" style="text-decoration:none">${esc(g.name)}</a></b></td>
    <td><form method="post" action="/admin/grants/${g.id}/payout" style="display:flex;gap:6px">
      <input type="text" name="payout_address" value="${esc(g.payout_address || '')}" placeholder="0x…" style="font-family:var(--mono);font-size:11px;padding:6px 8px;min-width:180px">
      <button class="btn sm">save</button></form></td>
    <td>${fmtEth(byId[g.id]?.raised || 0)}</td>
    <td>${fmtEth(byId[g.id]?.match || 0)}</td>
    <td><form method="post" action="/admin/grants/${g.id}/reject"><button class="btn sm" style="border-color:var(--red);color:var(--red)">unlist</button></form></td>
  </tr>`).join('')}
  </tbody></table>

  <h2 style="margin-top:44px">post an update</h2>
  <form method="post" action="/admin/updates" style="max-width:560px">
    <label>grant</label><select name="grant_id">${grants.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
    <label>title</label><input type="text" name="title" required maxlength="120">
    <label>body (markdown ok)</label><textarea name="body_md" rows="4"></textarea>
    <p style="margin-top:14px"><button class="btn solid" type="submit">publish to feed</button></p>
  </form>
  <p class="mono" style="font-size:10px;color:var(--ink-faint);margin-top:30px">round: ${esc(round.name)} · pool ${fmtEth(round.matching_pool_eth)} · blocks ${round.start_block} → ${round.end_block ?? 'live'} · indexing: ${SERVERLESS ? 'lazy (on traffic) + cron backstop' : 'every 45s'}</p>
</div></section>`;
  res.send(layout({ title: 'admin · ' + round.name, desc: 'round operator console' }, body));
}));

app.post('/admin/round', ah(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const round = await store.activeRound();
  const b = req.body;
  const fail = m => res.redirect('/admin?err=' + encodeURIComponent(m));
  const pool = parseFloat(b.matching_pool_eth), cap = parseFloat(b.match_cap_fraction), min = parseFloat(b.min_donation_eth);
  if (!b.name?.trim()) return fail('round needs a name');
  if (!(pool >= 0)) return fail('matching pool must be a number ≥ 0');
  if (!(cap > 0 && cap <= 1)) return fail('cap must be between 0 and 1 (e.g. 0.2 = 20% of the pool per project)');
  if (!(min >= 0)) return fail('min donation must be a number ≥ 0');
  const startAt = new Date(b.start_at + ':00Z'), endAt = new Date(b.end_at + ':00Z');
  if (isNaN(startAt) || isNaN(endAt)) return fail('bad dates');
  if (endAt <= startAt) return fail('the round has to end after it starts');
  const startBlock = b.start_block?.trim() ? parseInt(b.start_block, 10) : 0;
  if (!Number.isInteger(startBlock) || startBlock < 0) return fail('start block must be a block number');
  const endBlock = b.end_block?.trim() ? parseInt(b.end_block, 10) : null;
  if (endBlock !== null && (!Number.isInteger(endBlock) || endBlock <= startBlock)) return fail('end block must be after the start block');
  await store.updateRound(round.id, {
    name: b.name.trim().slice(0, 80),
    description: (b.description || '').trim().slice(0, 500),
    matching_pool_eth: pool, match_cap_fraction: cap, min_donation_eth: min,
    start_at: startAt.toISOString(), end_at: endAt.toISOString(),
    start_block: startBlock, end_block: endBlock,
  });
  if (Number(round.start_block) !== startBlock) await store.resetCursor(round.id); // rescan from the new start
  bust();
  res.redirect('/admin?saved=1');
}));

app.post('/admin/grants/:id/approve', ah(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await store.setGrantStatus(Number(req.params.id), 'approved'); bust();
  res.redirect('/admin');
}));
app.post('/admin/grants/:id/reject', ah(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await store.setGrantStatus(Number(req.params.id), 'rejected'); bust();
  res.redirect('/admin');
}));
app.post('/admin/grants/:id/payout', ah(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const a = req.body.payout_address?.trim();
  if (a && !/^0x[0-9a-fA-F]{40}$/.test(a)) return res.status(400).send('bad address');
  await store.setGrantPayout(Number(req.params.id), a || null); bust();
  res.redirect('/admin');
}));
app.post('/admin/updates', ah(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const g = await store.grantById(Number(req.body.grant_id));
  if (g && req.body.title?.trim()) await store.createUpdate(g.id, req.body.title.trim().slice(0, 120), (req.body.body_md || '').slice(0, 8000));
  res.redirect('/admin');
}));

/* ---------- api ---------- */
app.get('/api/round', ah(async (req, res) => {
  const { round, grants, donations, byId } = await roundData();
  const donorTotals = {};
  for (const d of donations) {
    (donorTotals[d.dest] ??= {})[d.donor] = (donorTotals[d.dest]?.[d.donor] || 0) + d.amount_eth;
  }
  res.json({
    round: {
      name: round.name, slug: round.slug,
      matching_pool_eth: round.matching_pool_eth,
      match_cap_fraction: round.match_cap_fraction,
      min_donation_eth: round.min_donation_eth,
      start_at: round.start_at, end_at: round.end_at,
    },
    grants: grants.map(g => ({
      id: g.id, slug: g.slug, name: g.name, category: g.category,
      address: g.payout_address, ...byId[g.id],
    })),
    donorTotals,
  });
}));

app.post('/api/reindex', ah(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'nope' });
  const round = await store.activeRound();
  const r = await indexRound(round).catch(e => ({ error: e.message }));
  bust();
  res.json(r);
}));

// vercel cron backstop (lazy indexing on traffic is the primary trigger)
app.get('/api/cron', ah(async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(403).json({ error: 'nope' });
  const round = await store.activeRound();
  const r = round ? await indexRound(round).catch(e => ({ error: e.message })) : null;
  bust();
  res.json(r ?? { error: 'no round' });
}));

/* ---------- og images ---------- */
app.get('/og/round.png', ah(async (req, res) => {
  const { round, grants, totals } = await roundData();
  const st = roundStatus(round);
  const png = await ogPng(`round:${totals.raised}:${totals.donors}:${grants.length}`, {
    eyebrow: 'quadratic funding · ' + st.label,
    title: round.name,
    sub: 'breadth of support beats depth of pockets. donate eth, the pool follows the crowd.',
    stats: [
      { v: fmtEth(round.matching_pool_eth), k: 'matching pool' },
      { v: fmtEth(totals.raised), k: 'crowdfunded' },
      { v: String(totals.donors), k: 'contributors' },
      { v: String(grants.length), k: 'projects' },
    ],
  });
  res.type('png').setHeader('Cache-Control', 'public, max-age=300').send(png);
}));

app.get('/og/grant/:slug.png', ah(async (req, res) => {
  const g = await store.grantBySlug(req.params.slug);
  if (!g) return res.status(404).end();
  const { round, byId } = await roundData();
  const t = byId[g.id] || { raised: 0, donors: 0, match: 0 };
  const png = await ogPng(`grant:${g.slug}:${t.raised}:${t.donors}`, {
    eyebrow: g.category + ' · ' + round.name,
    title: g.name,
    sub: g.tagline,
    stats: [
      { v: fmtEth(t.raised), k: 'raised' },
      { v: String(t.donors), k: 'contributors' },
      { v: fmtEth(t.match), k: 'est. match' },
    ],
  });
  res.type('png').setHeader('Cache-Control', 'public, max-age=300').send(png);
}));

/* ---------- errors ---------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(layout({ title: 'error' }, `<section class="block"><div class="wrap"><h1>something broke</h1><p class="lede">try again in a moment. if it persists, ping the operators in the telegram.</p></div></section>`));
});

/* ---------- boot ---------- */
if (!SERVERLESS) {
  app.listen(PORT, () => {
    console.log(`grants app → http://localhost:${PORT}`);
    console.log(`admin      → http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
    if (process.env.NO_INDEXER !== '1') startIndexer();
  });
}

export default app;
