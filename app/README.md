# extitutional grants

database-backed quadratic funding platform. ETH on ethereum mainnet, no custody —
donations go donor → project wallet in one transaction through the gitcoin-era
[BulkCheckout contract](https://etherscan.io/address/0x7d655c57f71464B6f83811C55D84009Cd9f5221C),
and an indexer reads the resulting `DonationSent` events back into postgres.

## run it locally

```sh
cd app
npm install
DATABASE_URL=postgres://… npm start   # → http://localhost:4870, admin key printed on boot
```

any postgres works (neon, prisma postgres, supabase, local docker). schema is
created and the round seeded automatically on first boot.

## deploy to vercel

the app runs as a single serverless function (`api/index.js` wraps express;
`vercel.json` routes everything to it).

```sh
cd app
vercel link            # or `vercel` to create the project
vercel env add DATABASE_URL production    # postgres connection string
vercel env add ADMIN_KEY production       # operator console key
vercel env add BASE_URL production        # e.g. https://grants.extitutional.io
vercel deploy --prod
```

indexing on vercel is **lazy**: any page view triggers an on-chain scan, throttled
to one pass/minute via an atomic db claim (safe across concurrent lambdas), plus a
daily cron backstop at `/api/cron`. on a long-lived server (`npm start`), a 45s
polling loop runs instead — `Dockerfile` + `fly.toml` included for that path.

## what's inside

- **browse** — `/` round home, `/grants` searchable directory, `/grants/:slug` detail
  pages (markdown, backers, updates), `/feed` town square, `/stats` dashboard
- **social unfurls** — every page ships og:/twitter: meta; `/og/round.png` and
  `/og/grant/:slug.png` are rendered server-side with live stats (sharp)
- **apply → approve** — `/apply` public form → operator queue at `/admin?key=…`
  (approve/reject, payout edits, post updates to the feed)
- **cart checkout** — add many grants, one signature, one mainnet tx. QF match
  previews (`match ∝ (Σ√cᵢ)²`, per-grant cap, min donation) recompute live
- **indexer** — DonationSent logs across rotating public RPCs, idempotent
  inserts, resumable cursor, adaptive getLogs chunking (10–800 block caps vary)

## config (env)

| var | default | notes |
|---|---|---|
| `DATABASE_URL` | local docker url | postgres connection string (required in prod) |
| `BASE_URL` | derived from request | set in prod so og:image urls are canonical |
| `ADMIN_KEY` | generated + persisted in db | operator console auth |
| `PORT` | 4870 | server mode only |
| `ETH_RPCS` | 5 public providers | comma-separated override |
| `CRON_SECRET` | unset | if set, `/api/cron` requires `Authorization: Bearer …` |
| `NO_INDEXER` | unset | `1` disables the polling loop (server mode) |

the round is driven entirely from `/admin`: name, description, matching pool,
per-project cap, min donation, start/end dates, and the indexer's start/end
blocks are all editable there. first boot seeds one blank round (start block =
current mainnet head) and zero grants — projects arrive via `/apply` and your
approval queue. indexing stays paused until a start block is set.

## trust model

- server never holds funds; the db is a read-model of the chain
- anyone can recompute matches from public events (auditability > trust)
- sybil resistance v1 = one wallet, one voice; trustgraph weighting is roadmap
