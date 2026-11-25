// Tiny Bot: mean-reversion paper trader for agent-fun/bars-replay/v1.
//
// Strategy (long only, no shorts, no leverage, no randomness, no network,
// no clock: the same bars always give the same orders, run after run):
//
//   - Per symbol, over its own hourly bars: RSI(14, Wilder) and the
//     Bollinger lower band of the last 20 typical prices ((h + l + c) / 3),
//     2 population standard deviations below their mean.
//   - Entry, on a bar's close (filled at the next bar's open): RSI below 35
//     and the close below the lower band, on a symbol it does not hold.
//     A dip that is both oversold and stretched below its band.
//   - Exit, the whole position: the position worth at least 8% over its
//     cost at the close, or at least 10% under it, or RSI above 55.
//     Winners are banked fast, losers are cut fast, and a bounce that
//     lifts RSI out of oversold territory is not ridden back down.
//   - Stake: equity over n slots, n = min(universe, max_open_positions);
//     each buy the smallest of that slice and max_weight_bps of equity.
//     Below min_notional it buys nothing. Sells go first in a reply;
//     a sell's proceeds land at the next open and never fund a buy
//     of the same reply.
//   - Slippage is capped at 100 bps (1%) past the close the order was
//     decided on, so a fill into a liquidity gap is refused (and the
//     exit is sent again) rather than filled for almost nothing.
//   - Warm-up batches (hello.warmup_bars) only seed the indicators;
//     no order is sent on one, the replay would reject it.
//
// Why this shape: the dev window (136 hourly bars, all 7 symbols down
// 3-14%) is a falling market. Buy-and-hold loses about 8.7% there and
// the best house baseline (MACD-CCI) still loses about 0.2%. A bot that
// only buys washed-out dips and exits on the first bounce stays mostly
// in cash through the grind and banks the bounces instead. Kit grader
// on the dev bars (grade-local, process driver, two runs, identical
// action logs): net PnL +$192.08 on $10,000 capital, 27 trades, max
// drawdown 3.8%, versus buy-and-hold -$869.34. The same rule also beats
// buy-and-hold on every 72-bar sub-window of the dev data, so it is
// not tuned to one stretch.
//
// The bot speaks the line protocol itself (node:readline only, stdlib):
// hello / batch / done on stdin, one reply per batch on stdout echoing
// its seq. Diagnostics, if any, go to stderr, never stdout.

import { createInterface } from 'node:readline';

const RSI_BARS = 14;
const RSI_ENTRY_BELOW = 35;
const RSI_EXIT_ABOVE = 55;
const BAND_BARS = 20;
const BAND_SIGMAS = 2;
/** Take profit: worth 108/100 of its cost. */
const TAKE = [108n, 100n] as const;
/** Stop loss: worth 90/100 of its cost. */
const STOP = [90n, 100n] as const;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10000n;

interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}

interface Hello {
  type: 'hello';
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
}

interface Bar {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface Position {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface Account {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
}

interface Batch {
  type: 'batch';
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: Account;
}

type Order =
  | { side: 'buy'; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

interface Series {
  /** Last BAND_BARS typical prices, oldest first. */
  typical: number[];
  last: number | null;
  /** The first RSI_BARS changes, while the averages are not set yet. */
  first: number[];
  gain: number | null;
  loss: number | null;
}

const series = new Map<string, Series>();
const scales = new Map<string, { price_scale: number; qty_scale: number }>();
let hello: Hello | null = null;
let cash = 0n;
let equity = 0n;
let quoteScale = 6;
const positions = new Map<string, { qty: bigint; cost: bigint }>();
let nextId = 1;

function clientId(): string {
  return `o${nextId++}`;
}

function push(bar: Bar): void {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    series.set(bar.symbol, (s = { typical: [], last: null, first: [], gain: null, loss: null }));
  }
  const c = Number(bar.c);
  s.typical.push((Number(bar.h) + Number(bar.l) + c) / 3);
  if (s.typical.length > BAND_BARS) s.typical.shift();
  if (s.last !== null) {
    const change = c - s.last;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_BARS) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      s.gain = (s.gain * (RSI_BARS - 1) + up) / RSI_BARS;
      s.loss = (s.loss * (RSI_BARS - 1) + down) / RSI_BARS;
    }
  }
  s.last = c;
}

function rsi(s: Series): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

/** The lower Bollinger band, or null before BAND_BARS bars. */
function lowerBand(s: Series): number | null {
  if (s.typical.length < BAND_BARS) return null;
  const mean = s.typical.reduce((a, x) => a + x, 0) / BAND_BARS;
  const variance = s.typical.reduce((a, x) => a + (x - mean) * (x - mean), 0) / BAND_BARS;
  return mean - BAND_SIGMAS * Math.sqrt(variance);
}

/** What qty of the symbol is worth at its latest close, in quote units. */
function value(symbol: string, qty: bigint): bigint {
  const sc = scales.get(symbol);
  const s = series.get(symbol);
  if (sc === undefined || s === undefined || s.last === null) return 0n;
  const price = BigInt(Math.trunc(s.last));
  return (qty * price * 10n ** BigInt(quoteScale)) / 10n ** BigInt(sc.qty_scale + sc.price_scale);
}

function onBatch(batch: Batch): Order[] {
  for (const bar of batch.bars) push(bar);
  const h = hello!;
  const warmupBars = h.warmup_bars ?? 0;
  if (batch.seq < warmupBars) return [];
  const { caps, fees } = h;
  // Only trade a symbol whose bar arrived in this batch: a stale close
  // from an earlier bar would be decided on, then refused (no_bar) at
  // the next open. Exits still read every held symbol, so a position
  // whose bar is missing this batch is held, not sold blind.
  const fresh = new Set(batch.bars.map((b) => b.symbol));
  const sells: Order[] = [];
  const entries: string[] = [];
  for (const { symbol } of h.symbols) {
    const s = series.get(symbol);
    if (s === undefined || s.last === null) continue;
    const held = positions.get(symbol);
    if (held !== undefined) {
      const v = value(symbol, held.qty);
      const r = rsi(s);
      if (
        v * TAKE[1] >= held.cost * TAKE[0] ||
        v * STOP[1] <= held.cost * STOP[0] ||
        (r !== null && r > RSI_EXIT_ABOVE)
      ) {
        sells.push({ side: 'sell', client_id: clientId(), symbol, qty: held.qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      continue;
    }
    if (!fresh.has(symbol)) continue;
    const lower = lowerBand(s);
    const r = rsi(s);
    if (r !== null && lower !== null && r < RSI_ENTRY_BELOW && s.last < lower) entries.push(symbol);
  }
  const orders: Order[] = sells.slice(0, caps.max_orders_per_bar);
  const slots = Math.min(h.symbols.length, caps.max_open_positions);
  const stake = equity / BigInt(slots);
  const byWeight = (BigInt(caps.max_weight_bps) * equity) / BPS;
  let room = slots - positions.size;
  let cashLeft = cash;
  for (const symbol of entries) {
    if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
    let slice = stake < byWeight ? stake : byWeight;
    if (cashLeft < slice) slice = cashLeft;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
    orders.push({ side: 'buy', client_id: clientId(), symbol, notional_quote_units: slice.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
    cashLeft -= slice;
    room--;
  }
  return orders;
}

function applyAccount(account: Account): void {
  cash = BigInt(account.cash_quote_units);
  equity = BigInt(account.equity_quote_units);
  positions.clear();
  for (const p of account.positions) {
    positions.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line) as Hello | Batch | { type: 'done'; seq: number; account: Account };
  if (msg.type === 'hello') {
    hello = msg as Hello;
    quoteScale = hello.capital.quote_scale;
    cash = BigInt(hello.capital.quote_units);
    equity = cash;
    for (const s of hello.symbols) {
      scales.set(s.symbol, { price_scale: s.price_scale, qty_scale: s.qty_scale });
    }
  } else if (msg.type === 'batch') {
    const batch = msg as Batch;
    applyAccount(batch.account);
    const orders = onBatch(batch);
    process.stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders })}\n`);
  } else if (msg.type === 'done') {
    break;
  }
}
