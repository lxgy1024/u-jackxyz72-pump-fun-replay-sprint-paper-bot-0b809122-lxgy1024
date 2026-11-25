# Dawn Scalper — Pump.fun Replay Sprint

[![u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/lxgy1024/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-lxgy1024/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/lxgy1024/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-lxgy1024/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the pump.fun replay harness (`agent-fun/replay/v2`).
It buys a fresh launch in its first few slots when the opening tape looks like
real demand — the creator put in some of their own SOL, other wallets are
buying too, nobody has dumped yet, and the price has not already run away —
then lets a winner run under a trailing stop and cuts a loser fast.

- Stake: 0.10 SOL per coin, one buy per coin, at most 5 coins at once.
- Exits: stop-loss at −8% of cost, trailing stop armed at +15% (exits on a
  10% pullback from the peak), max hold 15 slots, exit at once if the
  creator sells, exit when the coin goes quiet for 20 slots.
- Deterministic: decisions use only slots, reserves and the tape. No clock,
  no randomness, no network.

Run it with `node main.ts` (Node 22+ strips the types). The SDK shim is
vendored at `vendor/makefun-bot.ts`.
