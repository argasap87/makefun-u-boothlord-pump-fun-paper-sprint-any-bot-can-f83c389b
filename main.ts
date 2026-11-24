// Ridge Runner: a momentum bot for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored as vendor/makefun-bot.ts.
// One fixed-size buy per rising curve; losers cut fast, runners left to run.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
