// Dawn scalper for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea: buy a fresh launch in its first few slots, but only when the opening
// tape looks like real demand rather than a setup — the creator put in some of
// their own SOL, other wallets are buying too, nobody has dumped yet, and the
// price has not already run away. Then let a winner run under a trailing stop
// and cut a loser fast. One buy per coin, never more than five coins at once.
//
// Everything here is deterministic: decisions use only slot numbers, reserves
// and the tape the harness delivers. No clock, no randomness, no I/O.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry knobs -----------------------------------------------------------
const STAKE = SOL / 10n; // 0.10 SOL per coin
const MIN_BUY = SOL / 200n; // 0.005 SOL: smallest buy worth the tx fee
const ENTRY_MAX_AGE = 4; // buy only within 4 slots of the CreateEvent
const MIN_REAL_SOL = (SOL * 25n) / 100n; // curve must hold >= 0.25 SOL
const MAX_REAL_SOL = SOL * 50n; // and not more than 50 SOL (already pumped)
const DEV_BUY_MIN = SOL / 200n; // creator's own buy in the create slot
const DEV_BUY_MAX = SOL * 3n; // too big a creator pre-buy smells like a setup
const MIN_BUYERS = 4; // distinct non-creator buyers seen before entry
const MIN_FLOW = SOL / 10n; // ...and this much net buy flow
const MAX_BIG_SELL_BPS = 800; // no single outside sell over 8% of real reserve
const MAX_RUNUP_BPS = 3000; // price at most +30% over the create price
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- exit knobs ------------------------------------------------------------
const STOP_BPS = 600; // sell all at -6% of cost
const TRAIL_ARM_BPS = 1200; // trailing stop arms at +12%
const TRAIL_DROP_BPS = 800; // ...then exits on an 8% pullback from the peak
const MAX_HOLD_SLOTS = 20; // never hold longer than this
const STALE_SLOTS = 20; // exit when no trade has hit the coin for this long
const FEE_BPS = 125n; // protocol 95 + creator 30 bps, charged on each side

// ---- per-coin tape ---------------------------------------------------------
interface Launch {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  decided: boolean;
  complete: boolean;
}

interface Open {
  openedSlot: number;
  peak: bigint; // best sell value seen so far (lamports, net of one tx fee)
  armed: boolean; // trailing stop armed (value once reached +15%)
}

const launches = new Map<Pubkey, Launch>();
const open = new Map<Pubkey, Open>();

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const out = (tokens * vq) / (vt + tokens);
  return out - (out * FEE_BPS + 9999n) / 10_000n;
}

/** Net buy flow (buys minus sells, lamports) seen on a coin's tape. */
function netFlow(c: Launch): bigint {
  return c.bought - c.soldByOthers;
}

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      launches.set(e.mint, {
        mint: e.mint,
        creator: e.creator,
        createSlot: e.slot,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0n,
        devSold: false,
        lastTradeSlot: e.slot,
        decided: false,
        complete: false,
      });
    } else if (e.event === 'TradeEvent') {
      const c = launches.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.lastTradeSlot = e.slot;
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
        const reserveBefore = BigInt(e.real_quote_reserves) + sol;
        if (reserveBefore > 0n) {
          const bps = (sol * 10_000n) / reserveBefore;
          if (bps > c.bigSellBps) c.bigSellBps = bps;
        }
      }
    } else {
      const c = launches.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.decided = true;
      }
    }
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  readEvents(batch);
  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = state.txFeeLamports();

  // The harness closes positions itself on complete / flatten / writeoff:
  // drop our tracking for any coin we no longer hold.
  for (const f of batch.fills) {
    if (f.client_id.startsWith('_')) open.delete(f.mint);
  }
  for (const mint of [...open.keys()]) {
    if (!state.positions.has(mint)) open.delete(mint);
  }

  // ---- exits first ---------------------------------------------------------
  for (const [mint, pos] of state.positions) {
    if (orders.length >= cap) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    let rec = open.get(mint);
    if (rec === undefined) {
      rec = { openedSlot: state.slot, peak: 0n, armed: false };
      open.set(mint, rec);
    }
    const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
    const cost = pos.cost_lamports;
    if (value > rec.peak) rec.peak = value;
    if (cost > 0n && rec.peak * 10_000n >= cost * (10_000n + BigInt(TRAIL_ARM_BPS))) rec.armed = true;

    let exit = false;
    if (cost > 0n && value * 10_000n <= cost * (10_000n - BigInt(STOP_BPS))) exit = true;
    if (rec.armed && value * 10_000n <= rec.peak * (10_000n - BigInt(TRAIL_DROP_BPS))) exit = true;
    if (state.slot - rec.openedSlot >= MAX_HOLD_SLOTS) exit = true;
    const tape = launches.get(mint);
    if (tape !== undefined) {
      if (tape.devSold) exit = true;
      if (state.slot - tape.lastTradeSlot >= STALE_SLOTS) exit = true;
    }
    if (!exit) continue;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    open.delete(mint);
    const done = launches.get(mint);
    if (done !== undefined) done.decided = true;
  }

  // ---- entries -------------------------------------------------------------
  let free = state.freeCashLamports();
  let room = state.hello.caps.max_open_positions - state.committedPositionCount();
  for (const c of launches.values()) {
    if (orders.length >= cap || room <= 0) break;
    if (c.decided || c.complete) continue;
    const age = state.slot - c.createSlot;
    if (age < 0 || age > ENTRY_MAX_AGE) {
      if (age > ENTRY_MAX_AGE) c.decided = true;
      continue;
    }
    if (c.devSold) {
      c.decided = true;
      continue;
    }
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) continue;
    const real = curve.real_quote_reserves;
    if (real < MIN_REAL_SOL || real > MAX_REAL_SOL) continue;
    if (c.devBuy < DEV_BUY_MIN || c.devBuy > DEV_BUY_MAX) continue;
    // Both signals now: several distinct buyers AND real net buy flow.
    if (c.buyers.size < MIN_BUYERS || netFlow(c) < MIN_FLOW) continue;
    if (c.bigSellBps > BigInt(MAX_BIG_SELL_BPS)) continue;
    // Price run-up since creation, in bps over the create price.
    const runup = (curve.virtual_quote_reserves * c.vt0 * 10_000n) / (curve.virtual_token_reserves * c.vq0);
    if (runup > 10_000n + BigInt(MAX_RUNUP_BPS)) continue;

    const maxBuy = state.maxBuyLamports(c.mint);
    const amount = STAKE < maxBuy ? STAKE : maxBuy;
    if (amount < MIN_BUY) continue;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    free -= amount + tx;
    room -= 1;
    c.decided = true;
  }
  return orders;
}

await runBot({ onBatch });
