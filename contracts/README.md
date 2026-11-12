# Contracts of the market maker

The market maker has no public API (it is not routed by the gateway; plan 6.4) and publishes no event. Its contracts
are what it consumes and what it calls; the code follows them, and the contract tests (`tests/contracts`) check both
the code and the copies below.

| File | What it is |
|---|---|
| `asyncapi.yaml` | The four events it consumes (MarketOpened, MarketClosed, MarketResolved from markets; TradeExecuted from trading), the attributes it reads (EP-1: envelope only) and its two durable consumers |
| `outgoing/trading-bot.openapi.yaml` | Its expectation of trading's internal API: GET open markets, GET bot-book, PUT bot-orders (a subset of trading's `contracts/internal.openapi.yaml`) |
| `external/trading-internal.openapi.yaml` | Copy of trading's `contracts/internal.openapi.yaml` |
| `external/trading-asyncapi.yaml` | Copy of trading's `contracts/asyncapi.yaml` (TradeExecuted) |
| `external/markets-asyncapi.yaml` | Copy of markets' `contracts/asyncapi.yaml` (MarketOpened, MarketClosed, MarketResolved) |

## The copies

Each service lives in its own repository, so the files of the other services are copied here, unchanged, and the tests
read the copies (never fetched over the network). The hash test always runs and compares each copy with the hash below;
a second test compares each copy with the file in the sibling repository and runs only where that repository sits beside
this one (in the pipeline of this repository alone it is reported as skipped, so a change in trading or markets is not
noticed there until someone copies it). When trading or markets change a contract, copy the new file over the old one,
update its hash below and run the tests: a failing contract test is the point of the copy.

trading's `TradeExecuted` gained the optional field `kind` (`buy` or `sale`, UC-08; contract version 0.2.0). A sale
moves the bot's book as the buy of the other side it makes, and the bot reads only the envelope (and `tradeSequence`
for its logs), so a sale is one more notice to quote the market again; nothing in the bot changes. The internal
API copy is unchanged.

| Copy | Origin | SHA-256 at copy time (2026-11-11) |
|---|---|---|
| `external/trading-internal.openapi.yaml` | trading `contracts/internal.openapi.yaml` | `18839d67c46ec1d5c0511ade9c00e180fd3a5dbd9687e1f6e7420f5505ff219b` |
| `external/trading-asyncapi.yaml` | trading `contracts/asyncapi.yaml` | `1f6c5807c5e230e055abf98143fd428feeae9218b7a929ef2ba24819b3dafb61` |
| `external/markets-asyncapi.yaml` | markets `contracts/asyncapi.yaml` | `acf84a54d60b39dc6f40e1e046afe8f58387abd0bde30bbae75285ff69c55ff8` |

## What the contract tests check

- Every path, method, status and schema of `outgoing/trading-bot.openapi.yaml` exists in the trading copy, and every
  schema the bot reads is compatible (same required fields and types).
- The trading client parses bodies that validate against the trading copy, and every request it sends validates
  against it (the PUT body: `additionalProperties: false`).
- `readMarketNotice` reads a valid example of each of the four events of the publishers' copies, and every
  attribute it reads is a required attribute of the publisher's envelope.
- Every offer list the pricing returns validates against the `Offer` schema.
