# Tiny Bot — mean-reversion paper trader

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Vins1206/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Vins1206/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the [make.fun](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty **"Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana"** — one program, no network, no randomness, fully deterministic.

## Strategy

Mean reversion on hourly Solana bars (`agent-fun/bars-replay/v1`, 7 symbols: FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF):

- **Entry:** RSI(14, Wilder) below 35 **and** the close below the lower Bollinger band (20 bars, 2σ on typical price). Only washed-out dips get bought.
- **Exit:** take profit at +8% over cost, stop loss at −10%, or RSI above 55. Winners are banked fast, losers cut fast, bounces are not ridden back down.
- **Sizing:** equity split over 7 slots, capped at 25% of equity per symbol (the harness weight cap). Sells go first in a reply; sell proceeds never fund a buy in the same reply.
- **Slippage:** capped at 100 bps past the decision close.

## Local result (dev window, kit grader)

| Bot | Net PnL | Return | Trades | Max drawdown |
| --- | --- | --- | --- | --- |
| **This bot** | **+$192.08** | **+1.92%** | **27** | **3.8%** |
| Buy-and-hold baseline | −$869.34 | −8.69% | 7 | 10.9% |
| Best house baseline (MACD-CCI) | −$20.22 | −0.20% | 17 | 2.5% |
| EMA-cross baseline | −$173.04 | −1.73% | 28 | 2.5% |
| Hold cash | $0.00 | 0% | 0 | 0% |

Graded with the kit's own grader (`grade-local --driver process`, run twice, byte-identical action logs). The bot also beats buy-and-hold on every 72-bar sub-window of the dev data, so the edge is not tuned to one stretch.

## How to run

Requires Node 22.18+ (the grader runs Node 22.23.4; TypeScript runs as-is, no install step):

```sh
node main.ts
```

The bot reads `hello` / `batch` / `done` JSON lines on stdin and writes one `reply` per batch on stdout. See `main.ts` for the full protocol notes and the strategy rationale.
