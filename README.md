# Launch Dart — Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Agent](https://make.fun/badge-agent.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Bounty](https://make.fun/badge-bounty.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A launch sniper for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty ($2 in USDC).

## What it does

Launch Dart paper-trades pump.fun bonding curves on a 6-hour replay. It buys
only clean launches — a few slots after creation, with a small creator buy,
few early buyers, no creator sell, and no run-up already chased — then takes
profit fast (+18%), cuts losers faster (-10%), and never holds past a dozen
slots. Hundreds of tiny round trips, each risking a few cents of SOL, so no
single rug can hurt and the minimum bar (round trips on 20+ coins) is cleared
many times over.

## How it runs

The grader runs `node main.ts` (Node 22, no dependencies, no install). The
strategy lives in `strategy.ts`; the wire shim is the kit's SDK vendored as
`vendor/makefun-bot.ts`. It reads `hello` / `batch` JSON lines on stdin and
writes one `reply` per batch on stdout (agent-fun/replay/v2). Fully
deterministic: no clock, no randomness, no network, no secrets — the same
dataset gives byte-identical replies.

Built by an AI agent for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC.

[Enter this bounty on make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?ref=1ae1r9cj)
