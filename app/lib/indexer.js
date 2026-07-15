// on-chain donation indexer: polls BulkCheckout DonationSent logs and writes
// them into postgres. idempotent (UNIQUE tx_hash+log_index), resumable via a
// per-round cursor in meta. ETH-only by design for this round.
//
// two trigger modes:
//  - long-lived server: startIndexer() interval loop
//  - serverless (vercel): maybeIndex() — lazy, fired on page views, throttled
//    through an atomic db claim so concurrent lambdas don't stampede
import { ETH_TOKEN, fetchDonationLogs, latestBlock, blockTime } from './chain.js';
import * as store from './db.js';

export async function indexRound(round) {
  if (!round.start_block || Number(round.start_block) <= 0) return { scanned: 0, inserted: 0 }; // not configured yet
  const cursorKey = `cursor:${round.id}`;
  const from = Number((await store.getMeta(cursorKey)) ?? round.start_block);
  const head = await latestBlock();
  const to = round.end_block ? Math.min(Number(round.end_block), head) : head;
  if (from > to) return { scanned: 0, inserted: 0 };

  const grants = (await store.approvedGrants(round.id)).filter(g => g.payout_address);
  const byAddr = new Map(grants.map(g => [g.payout_address.toLowerCase(), g]));

  const logs = await fetchDonationLogs(from, to);
  let inserted = 0;
  for (const d of logs) {
    if (d.token !== ETH_TOKEN) continue;           // ETH donations only
    const grant = byAddr.get(d.dest);
    if (!grant) continue;                          // not a grant in this round
    const res = await store.insertDonation({
      tx_hash: d.tx_hash,
      log_index: d.log_index,
      block_number: d.block_number,
      block_time: await blockTime(d.block_number).catch(() => null),
      donor: d.donor,
      dest: d.dest,
      amount_wei: d.amount_wei.toString(),
      amount_eth: Number(d.amount_wei) / 1e18,
      grant_id: grant.id,
      round_id: round.id,
    });
    inserted += res.changes;
  }
  // small reorg buffer: next pass re-scans the last 12 blocks
  await store.setMeta(cursorKey, Math.max(Number(round.start_block), to - 12));
  return { scanned: to - from + 1, inserted };
}

// serverless-safe lazy trigger: at most one pass per interval across all lambdas
export async function maybeIndex(minIntervalMs = 60000) {
  try {
    if (!(await store.claimIndexSlot(Date.now(), minIntervalMs))) return null;
    const round = await store.activeRound();
    if (!round) return null;
    const r = await indexRound(round);
    if (r.inserted) console.log(`[indexer] +${r.inserted} donation(s)`);
    return r;
  } catch (e) {
    console.warn('[indexer] lazy pass failed:', e.message);
    return null;
  }
}

export function startIndexer(intervalMs = 45000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const round = await store.activeRound();
      if (round) {
        const { inserted } = await indexRound(round);
        if (inserted) console.log(`[indexer] +${inserted} donation(s)`);
      }
    } catch (e) {
      console.warn('[indexer] pass failed:', e.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
