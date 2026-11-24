// Launch Dart: a launch sniper for the pump.fun replay (agent-fun/replay/v2).
//
// The observation behind it: on a bonding curve, the only moment a small bot
// can reliably be early is the launch itself. A few slots after a coin is
// created, the tape already says whether the launch is clean or a dump in
// waiting — how big the creator's own buy was, how many wallets piled in
// beside them, whether the creator has already sold. This bot buys only
// launches that pass those checks, takes profit fast, cuts losers faster, and
// never holds past a dozen slots. Breadth is the point: hundreds of tiny
// round trips, each risking a few cents of SOL, so no single rug can hurt and
// the guardrail (round trips on 20+ coins) is cleared many times over.
//
// Entry (decided within maxAge slots of the CreateEvent):
//   - the creator's own buy in the create slot is small (a big dev buy is a
//     dump in waiting), at most maxBuyers distinct non-creator buyers so far
//     (a launch bundled by many wallets is the creator's cluster), the
//     creator has not sold, real SOL is at least minRealSol (so the 1% size
//     cap still admits a minimum buy), and the price has not already run up
//     past maxRunup over its create price (no chasing).
// Exits (whole position, at once):
//   - take profit at +tp over cost, stop loss at -sl under cost, a hard time
//     limit of maxHold slots, or the moment the creator sells while held.
// Buys are capped at 1% of the curve's real SOL (the harness's own cap), so a
// buy on a thin launch is small by construction; the minimum buy keeps dust
// out. One buy per coin, never re-entered.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. Two executions on the same
// dataset give byte-identical replies.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this (a big dev buy is a dump). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Price now over the create price: at most this (no chasing a coin that ran). */
  maxRunup: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost. */
  takeProfit: number;
  /** Exit when it is worth this much under its cost. */
  stopLoss: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 4,
  stakeSol: 0.08,
  minBuySol: 0.005,
  minRealSol: 0.5,
  maxRealSol: 30,
  maxDevBuySol: 2,
  maxBuyers: 4,
  maxRunup: 0.4,
  skipDevSold: true,
  buySlipBps: 10_000,
  takeProfit: 0.18,
  stopLoss: 0.1,
  maxHold: 12,
  exitOnDevSell: true,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: number;
  vt0: number;
  devBuy: number;
  buyers: Set<Pubkey>;
  devSold: boolean;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            vq0: Number(e.virtual_quote_reserves),
            vt0: Number(e.virtual_token_reserves),
            devBuy: 0,
            buyers: new Set(),
            devSold: false,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
        }
      }
      for (const mint of [...selling]) {
        let stillPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') stillPending = true;
        }
        if (!stillPending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let buyPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') buyPending = true;
          }
          if (!buyPending) held.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      // Exits first: take profit, stop loss, time limit, creator sold.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 0;
        if (vt <= 0) continue;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (value <= cost * (1 - p.stopLoss)) exit = true;
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: clean launches only, decided within maxAge slots of creation.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let open = state.committedPositionCount();
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        if (c.devBuy > p.maxDevBuySol) continue;
        if (c.buyers.size > p.maxBuyers) continue;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const runup = (vq * c.vt0) / (vt * c.vq0) - 1;
        if (runup > p.maxRunup) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }
      return orders;
    },
  };
}
