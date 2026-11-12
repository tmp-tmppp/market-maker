# market-maker

The market-maker bot of **Chance**. It is a stateless service without a user interface: for every open market of every
tenant it keeps a short ladder of YES and NO offers resting in **trading**, so a trader can always buy from someone. It
does not hold any money or shares itself: its holdings are the bot account that trading keeps per market (funded by the
market's creator when the market opens, ADR-013), and the creator gets back what is left at settlement. The bot reads
that account from trading, prices it, and replaces its offers there, so the creator can lose at most the funding.

It has no database, no inbox, no outbox, no public API and publishes no event (SVC-MMK, plan 6.4). The gateway does not
route to it; the only HTTP endpoints are the health probes and, on a port of its own, `GET /metrics` (see "Metrics").

## What it does

The flow is the plan's FL-A, steps 3 to 7, with the event as a notification only (EP-1, ADR-040, ADR-041):

1. **MarketOpened** (from markets) or **TradeExecuted** (from trading) arrives on a durable JetStream consumer. The bot
   reads only the envelope of the event: the market, the tenant and the trade sequence. Nothing else of the payload is used.
2. It reads its **book** from trading (`GET /v1/internal/markets/{id}/bot-book`): the status of the market, the bot
   account's holdings (credits, YES, NO), the offers now resting, the trade sequence, the funding, the starting price and
   the most offers per side trading accepts (`maxOffersPerSide`).
3. It computes the offers it wants (see "Pricing"). When they equal the offers already resting, and those were priced on
   the current trade sequence, it stops: nothing is sent.
4. Otherwise it **replaces all its offers of the market in one call** (`PUT /v1/internal/markets/{id}/bot-orders` with
   `basedOnSequence`, the trade sequence of the book it priced). If a trade happened in between, trading answers `409
   stale_sequence`: the bot waits a short random time and starts again from the read, up to 5 times, then gives the market
   up until the next event or check (`contended`).
5. **MarketClosed** and **MarketResolved** only stop the quoting; trading cancels the resting offers itself.

**The periodic check.** Events can be missed (an outage, a restart), so on start and then `RECHECK_INTERVAL_MS` (30 s)
after the end of the previous run, the bot lists every open market of every tenant
(`GET /v1/internal/markets?status=open`) and runs the same read, compare and replace for each. This is also how it
recovers without replaying events: events older than a minute before the process started are skipped, because the
start-up check reads every open book anyway. A market that always fails (counted in `failed`) never starves the markets
after it, and when trading itself is unreachable (or its failures opened the circuit) the next run resumes where the last
one stopped: at the market after the last one tried, or at the market the open circuit turned away without a request.

The reaction is **idempotent by construction**: it always re-reads the book and sends a whole list priced on the current
sequence, and an equal list is not even sent. A duplicate, late or reordered event therefore costs one read. That is why
the bot needs no inbox (ADR-018), and no database at all.

The bot calls trading with the client credentials of the Keycloak client `market-maker` (REQ-24); trading takes the
tenant from the market, so one service account serves every tenant.

## Pricing

Defined in ADR-057 (**Proposed**, `docs/adr/0057-market-maker-constant-product-pricing.md` in the docs repository, decision
pending; Q-18 (b) and (c)). Pure
functions in [`src/domain/pricing.ts`](src/domain/pricing.ts), [`offers.ts`](src/domain/offers.ts) and
[`book.ts`](src/domain/book.ts); no I/O, and every quantity is an exact integer.

**In plain words.** The bot treats its YES shares and NO shares as a pool (a constant-product curve, the idea of an
automated market maker). Credits it holds count as pairs it can still create, so each side of the pool is its own shares
plus its credits. The price of YES is the share of NO in the pool:

    YES price = n / (y + n)        NO price = 1 - YES price

The more NO the pool holds compared with YES, the dearer YES is. Every trade moves the price the way the trade went: a
YES buy never lowers the YES price and a NO buy never raises it (a property test checks this over random sessions).

**The starting price.** The creator funds 5000 credits and picks a starting price. At 0.50 the bot holds 5000 YES and
5000 NO and the YES price is 5000 / (5000 + 5000) = 0.50. At 0.60 the pool has to hold less YES than NO, so the bot
**holds back** 1666.67 of its 5000 YES shares: they are never offered (and go back to the creator with the rest of the
account at settlement). The pool is then 3333.33 YES and 5000 NO, and the price is 5000 / 8333.33 = 0.60. The held-back
amount follows from the funding and the starting price, which trading returns in every book, so the bot needs to
remember nothing. It starts at exactly the starting price for every funding of at least 1 credit and every price on the
0.01 grid (tested for all 99 prices).

**The ladder.** Each side gets up to `LEVELS` offers, one 0.01 step apart. The cheapest sits half the spread above the
reference price, rounded up to the grid; each next level is one step dearer. A level offers what the curve sells while
that side's price moves from the bottom to the top of its step, rounded down, and a side never offers more than its pool
(never a held-back share, never more than its shares plus credits). Offers above 0.99 are dropped, never clamped down.

**Example.** 5000 credits at 0.50 with the defaults (spread 0.02, 3 levels): YES at 0.51, 0.52 and 0.53 and NO at 0.51,
0.52 and 0.53, about 200 shares on each level. When a trader buys the whole first YES level (about 200 shares for about
102 credits), the reference price rises to about 0.51, and at the next requote the YES ladder starts a step higher and
the NO ladder about a step lower.

**Why the spread is at least 0.02.** `SPREAD_MICRO` has a minimum of 20 000 microcredits (0.02), two grid steps, so half
the spread is at least one step and every level costs at least what the curve asks at the top of its step. Then the offers
of one quote never sell below that quote's curve: whatever buys hit them before the next requote, y x n stays at or above
its value at the quote (one buy can lower it against the pool just before it, never below that), and **a pair of one YES
and one NO share bought from the bot costs at least 1 credit** across any sequence of fills and requotes (along the curve
it costs exactly 1, and a pair pays out exactly 1). A narrower spread would sell the cheapest level below the curve, and a trader alternating YES and NO buys
between two requotes could then buy pairs for less than 1 credit, which the bot's creator would pay for. The tests
include that round trip at the minimum spread and fail when the minimum is set to 0.

**The edges (documented, not a defect).** A side has offers only while its cheapest price, the reference plus half the
spread rounded up, is at most 0.99. At the default spread a market that opens at 0.99 has no YES offers at all, and one
at 0.98 has a single YES level at 0.99 (mirrored at 0.01 and 0.02 for NO). The same happens when trades drive the price
there. A YES buy is then refused (`insufficient_liquidity`) until someone buys NO. Restricting starting prices to
0.02..0.98 would open every market two-sided at the default spread, but it cannot cover wider spreads; it is a question
for markets (see "Follow-ups").

**How deep.** Each level holds about 2 % of the funding, so the levels decide the largest order a fresh market takes. A
1000-credit market at 0.50 offers about 63 credits per side with 3 levels, 84 with 4, 107 with 5 and 227 with 10
(computed with this service's pricing; at 0.30 the cheap YES side offers 31, 53 and 107). The chart sets 5, so a
100-credit order fills on a 1000-credit market at 0.50 and walks the price at most five steps before the next quote.

**How many levels.** `LEVELS` (1 to 10) is an upper bound. Trading returns its own runtime limit, `MAX_OFFERS_PER_SIDE`,
as `maxOffersPerSide` in every book, and the bot quotes the smaller of the two: `min(LEVELS, maxOffersPerSide)`, the
cheapest levels first. No deploy of the two charts has to match. Lowering the limit in trading refuses at most a PUT
already in flight: a run that read the old limit and sends more offers per side gets a 400 (`invalid_offers`, logged at
error and counted as `refused`), the old offers stay until then, and the next run (the next `TradeExecuted` or the
periodic check) reads the new limit and quotes within it.

**Units (ADR-055).** Credits and shares are integers in micro-units: microcredits, microshares, and prices in microcredits
per share on the 0.01 grid (10 000 to 990 000, step 10 000). A pair is 1 microcredit. JSON fields end in `Micro`. Products
and square roots use `BigInt`, so no floating point touches a quantity; the jitter of the retry wait is the only float.

## Events

Contract: [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml) (AsyncAPI 3.0); the copies of the other services'
contracts and their hashes: [`contracts/README.md`](contracts/README.md).

| Event | From | What the bot does |
|---|---|---|
| `MarketOpened` | markets (stream `MARKETS`) | Quotes the market (a trigger) |
| `TradeExecuted` | trading (stream `TRADING`) | Quotes the market again |
| `MarketClosed`, `MarketResolved` | markets (stream `MARKETS`) | Stops quoting (trading cancels the offers) |

Two durable pull consumers named `market-maker`, created or updated on every connect (filters `chance.markets.MarketOpened.*`,
`MarketClosed.*`, `MarketResolved.*` on `MARKETS`; `chance.trading.TradeExecuted.*` on `TRADING`): explicit ack, ack wait
30 s with a progress signal every 10 s while a message is handled, at most 10 unacknowledged messages, no delivery limit,
one message per pull (so a message waiting behind a long run does not pass its ack wait), handled one at a time. A durable
that is created starts at new messages; an existing one resumes where it was after an outage. A missing stream is logged and
retried every 5 s, and a stream or consumer deleted while running is created again.

A message is acknowledged for every outcome except `not_ready` (a funded market whose starting price trading has not
processed yet) and an error, which are nak'd with a 5 s delay. After 5 failed deliveries of one message it is logged as an
error and acknowledged: nothing is lost, because the periodic check quotes the market within `RECHECK_INTERVAL_MS`.

## Configuration

Settings come from environment variables; the service refuses to start with a clear message that names every problem when a
required one is missing or invalid, and never prints a value. In Kubernetes the non-secret ones come from the chart's
ConfigMap and the only secret one from the Secret `market-maker-env`. The rows marked **runtime** can also change while the
service runs (see "Runtime configuration"). The source of truth is [`src/config.ts`](src/config.ts) with
[`tests/config.test.ts`](tests/config.test.ts); `APP_ENV=local` is the only mode that may leave out the settings marked
"required" below (it then uses in-memory replacements).

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `APP_ENV` | `production` | no | `local` allows running without NATS and with a fake trading client; any other value (lowercase letters, digits and dashes) needs every required setting |
| `PORT` | `8080` | no | HTTP port of the health probes |
| `METRICS_PORT` | `9464` | no | Port of the separate listener that serves `GET /metrics` (1 to 65535); must differ from `PORT` (see "Metrics") |
| `LOG_LEVEL` | `info` | no | **runtime.** `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `QUOTING_ENABLED` | `true` | no | **runtime.** The kill switch: `false` stops every call to trading. The offers already resting stay and keep filling; it does not withdraw them |
| `SPREAD_MICRO` | `20000` | no | **runtime.** The spread in microcredits per share (20 000 to 200 000); each side's cheapest offer sits half of it above the reference price. The minimum keeps every level at or above the curve |
| `LEVELS` | `3` (the chart sets `5`) | no | **runtime.** Upper bound of the offers per side (1 to 10); the levels quoted are `min(LEVELS, maxOffersPerSide of trading's book)` |
| `RECHECK_INTERVAL_MS` | `30000` | no | **runtime.** Pause between the end of one check of all open markets and the start of the next (5000 to 600000) |
| `RUNTIME_CONFIG_FILE` | none | no | Path of the watched runtime file (the chart sets `/etc/market-maker/runtime/runtime.env`); without it no file is watched |
| `RUNTIME_CONFIG_POLL_MS` | `10000` | no | How often that file is read again (1000 to 3600000) |
| `NATS_URL` | required | no | NATS server (`nats://` or `tls://`, no user name or password). Local mode may leave it out: nothing is consumed then, and only the periodic check quotes |
| `TRADING_URL` | required | no | Base URL of trading's internal port, `http(s)://`, no login; in the cluster `http://trading:8081` (the chart builds it from `trading.host` and `trading.port`). Local mode may leave it out: an in-memory client with one open demo market answers |
| `KEYCLOAK_URL` | required | no | Keycloak base URL, for the bot's service token (in the cluster `http://identity:8080`). Local mode needs it once `TRADING_URL` is set |
| `KEYCLOAK_REALM` | required with `KEYCLOAK_URL` | no | Realm name |
| `MARKET_MAKER_CLIENT_ID` | `market-maker` | no | The service-account client of this service |
| `MARKET_MAKER_CLIENT_SECRET` | required with `KEYCLOAK_URL` | **yes** | Its client secret |
| `TRADING_TIMEOUT_MS` | `3000` | no | Timeout of one call attempt to trading (100 to 60000) |
| `TRADING_RETRIES` | `2` | no | Retries of a read after the first attempt, on network errors, timeouts, `408`, `429` and `5xx` (0 to 10); a write is never retried |
| `TRADING_CIRCUIT_FAILURES` | `5` | no | Consecutive failures that open the circuit breaker (1 to 100) |
| `TRADING_CIRCUIT_HALF_OPEN_MS` | `10000` | no | How long the circuit stays open before one call may try again (1000 to 600000) |
| `SHUTDOWN_DELAY_MS` | `0` | no | Drain delay after SIGTERM, 0 to 15000 (see "Shutdown"); nothing routes requests to the bot, so it does not need to wait |

### Runtime configuration

Five keys (`LOG_LEVEL`, `QUOTING_ENABLED`, `SPREAD_MICRO`, `LEVELS`, `RECHECK_INTERVAL_MS`) can change without a restart
(ADR-037). The order is: defaults, then the watched file `RUNTIME_CONFIG_FILE`, then environment variables, so a key set in
the environment always wins and the file's value for it is ignored (and logged); the chart therefore sets these keys only
in the file. The file's lines are `KEY=value` (blank lines and lines starting with `#` are skipped). The service reads the
file at start and then every `RUNTIME_CONFIG_POLL_MS`; a key that is missing from the file keeps its startup value, so
deleting a line undoes an override. A missing, unreadable or invalid file never stops the service: it keeps what it has, and
logs the problem. **An invalid or empty value keeps the value in force** (a key with nothing after the `=` counts as
invalid, not as missing; delete the whole line to go back to the startup value). **`QUOTING_ENABLED`, the kill switch,
fails closed instead:** an invalid or empty value (`QUOTING_ENABLED=flase`, `QUOTING_ENABLED=`) switches quoting off,
whatever was in force, and also after a restart that reads the same file, and the service logs it at `error`. So a typo
never switches a stopped bot back on. A misspelled key such as `QUOTING_ENABLE=false` is an unknown key: it is logged at
`warn` and ignored, so check the log after editing the switch.

In the chart the five keys are the `runtime` block of the values. They are rendered into a second ConfigMap,
`<release>-runtime` (key `runtime.env`), which the Pod mounts as the directory `/etc/market-maker/runtime` (never as a
`subPath`, which would not update). That ConfigMap is left out of the Deployment's checksum annotation on purpose: a change
reaches the running Pod within about a minute (the kubelet refreshes the mount, then the poll) and does not restart it.
Everything else in `env` is read at start, and a change restarts the Pod. `helm/values.schema.json` bounds every key as
`src/config.ts` does.

## Health

| Path | Answer |
|---|---|
| `GET /health/startup` | `200` once the server listens |
| `GET /health/ready` | `503` (`application/problem+json`, code `shutting_down`) while the bot drains after SIGTERM, otherwise `200 {"status": "up", "broker": "connected" \| "disconnected" \| "not_configured"}` |
| `GET /health/live` | `200` while the process runs |

The broker state is reported, never turned into a `503`: no traffic is routed to the bot, the periodic check quotes without
NATS, and a `503` while a stream is missing or NATS restarts would fail the smoke test and stall the rollout of a working
release. A consumer that loses its connection logs a warning and retries. Trading is **not** checked: its outage must not
take the bot out. Any other path is a `404` problem.

## Metrics

Rate, errors and duration of the HTTP endpoints (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the probes' port (`PORT`) never serves `/metrics`. The listener starts with the service and closes with it
  on shutdown (after the health server, so a scrape still answers while the last work finishes). The default is the same
  in every service, so services started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod
  has its own address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. The bot's HTTP surface is the three probes, so these
  count the probes (`route` is `/health/ready` and so on), the `404` of any other path and the `400` of a malformed URL
  (`route` is `unmatched`, counted by `recordFrameworkError` because Fastify answers it without the hooks; raw URLs never
  become a label value).
- **`tenant`** is always `none`: the bot has no authentication and no request names a tenant. It is never read from a
  header or the body.
- **`market_maker_quote_runs_total`** (counter, label `outcome`): how each quote run of one market ended, counted once per
  run (callers that share a waiting run share its count). `outcome` is `quoted` (a PUT replaced the offers), `unchanged`
  (no PUT needed), `stopped`, `not_ready`, `not_found`, `disabled` (the kill switch is off), `contended` (every attempt
  met `409 stale_sequence`), `refused`, or `error` (the run threw: trading unavailable, an answer outside the contract).
  The label has these nine values only, each starting at 0: no market id and no tenant id.
- **`market_maker_refused_puts_total`** (counter): the replacement PUTs that trading refused (`400`, or `409
  insufficient_holdings`). It should stay at 0: the bot checks its offers against the same rules first, so a refusal
  is a defect on one side (see "Resilience"). A list the bot itself refused to send (`outcome="refused"`, status 0 in the
  log) is not counted here.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port.

## Resilience (REL-04)

Every call to trading goes through one cockatiel policy: a timeout per attempt (`TRADING_TIMEOUT_MS`), a circuit breaker
shared by all calls (opens after `TRADING_CIRCUIT_FAILURES` consecutive failures, tries again after
`TRADING_CIRCUIT_HALF_OPEN_MS`), and for reads only an exponential backoff with jitter (250 ms to 2 s,
`TRADING_RETRIES` times). A write (`PUT bot-orders`) is never retried inside the client, because after a failure the
prices may be stale and the next attempt must read the book again. Redirects are never followed, so the bearer token
cannot leave for another host. A `401` drops the cached token and fails the call for the whole service (the periodic check
ends its run, a message is nak'd; the next call fetches a new token); a `403` means trading does not admit the client
`market-maker`; the token never appears in a log line or an error message.

Failures are counted rather than hidden: the periodic check logs one summary per run, at `warn` when `failed` or `refused`
is above 0. A `refused` count on every run is a defect to look at; a few right after trading lowered its
`MAX_OFFERS_PER_SIDE` are expected and clear on the next run.

## Shutdown

On SIGTERM or SIGINT the service shuts down in two steps:

1. **Drain.** `GET /health/ready` answers `503` from this moment, and the bot keeps working for `SHUTDOWN_DELAY_MS`
   (default 0: nothing routes requests to it).
2. **Close**, in this order: both consumers (the message in hand is finished and settled, the rest stay on the streams), the
   periodic check (a run in progress ends after the market it is quoting), the runtime-file watcher, the health server and the metrics listener.
   It exits with `0`; if closing takes more than 10 seconds after the delay, it exits with `1`.

The chart keeps `terminationGracePeriodSeconds: 30`: the delay is limited to 15 seconds, so delay plus close always ends
before Kubernetes sends SIGKILL.

## One replica, no state

- **No database, no inbox.** ADR-041 (a working default, proposed): the holdings and the offers live in trading, the reaction
  is idempotent (see "What it does"), and the only state in the process is in memory: a per-market queue that runs one quote
  at a time (a second request for a market that is already queued shares the queued run) and the timers.
- **Exactly one replica, with `strategy: Recreate`.** Trading's replacement call checks `basedOnSequence` only against
  trades, and a replacement does not change the trade sequence. Two bots on one market would both get `200` and the last
  would win; with different settings (a ConfigMap that has not reached one Pod yet) or different code (a rolling update)
  they would swap the book between their ladders on every trigger, and both would run the whole periodic check. So the
  chart fixes one replica (the schema has `const: 1`) and stops the old Pod before it starts the new one. The price is a
  short gap in each deploy, during which the resting offers keep filling.

## Run locally

Node.js 24 is required.

```bash
npm ci
npm run build
APP_ENV=local npm start          # a fake trading client with one open demo market, no NATS: only the periodic check quotes
curl http://localhost:8080/health/ready
```

In local mode the demo market (5000 credits at 0.60, closing in 30 days) is quoted on start and every
`RECHECK_INTERVAL_MS`; the log shows each quote with its offers. Set `RECHECK_INTERVAL_MS=5000` to see it quickly.

With a real NATS: `docker compose up --build` starts NATS with JetStream and the bot together, in local mode (see
[`compose.yaml`](compose.yaml)); the bot's health endpoint is then on host port 8090, because a local trading uses 8080.
The streams `MARKETS` and `TRADING` appear once the markets and trading services have
published to that NATS, so run them against it too (`nats://localhost:4222`); until then the bot logs that a stream is
missing and retries. To quote against a real trading service, also set `TRADING_URL` (in the cluster
`http://trading:8081`, on this machine `http://host.docker.internal:8091`), `KEYCLOAK_URL` (on this machine
`http://host.docker.internal:8081`), `KEYCLOAK_REALM` and `MARKET_MAKER_CLIENT_SECRET`, and start the identity provider;
the compose file shows how. Never write the secret into a tracked file.

## Tests

```bash
npm run lint                     # ESLint, including the layer rules below
npm run typecheck
npm test                         # unit, web and contract tests (one worker); npm test -- --coverage for the report (80 % threshold)
npm run test:integration         # a NATS server in a container (Testcontainers); needs Docker
```

- **Pricing** has property tests over random books and random trading sessions: starts at the starting price for every grid
  price, every list is on the grid, backed and never crossed, a YES fill never lowers the YES price, the product y x n never
  falls below its value at the quote (with a requote before every buy, and across many buys of either side against the
  offers one quote leaves resting), a pair never costs less than 1 credit (including the YES/NO round trip at the minimum
  spread), and the edge books at 0.01, 0.02, 0.98 and 0.99.
- **The use cases** run against an in-memory trading client with the semantics of trading's internal API (stale sequences,
  refusals, trades that fill the cheapest offer first, a market that always fails).
- **The trading client** runs against an injected `fetch`: every status of the three endpoints, retries only on reads and
  only on transient answers, the circuit breaker (and which calls it turned away without a request), no redirect, no token
  in a log. The periodic check is also run over this real client, so a market behind one that fails and opens the circuit
  is still reached.
- **The contract tests** fail when the outgoing contract is not a compatible subset of the copy of trading's, when a PUT body
  or a parsed book does not match trading's schemas, when a body of the in-memory trading client is one the real client would
  not accept, when an event does not match the publishers' envelopes, or when `contracts/asyncapi.yaml` and the consumed
  types differ. They read the copies in `contracts/external`, never the network. A further test compares each copy with
  the file in the sibling repository; it runs only where that repository sits beside this one and is skipped in the
  pipeline of this repository alone.
- **The integration test** checks both consumers' settings against the server, that a message is acknowledged only after
  its handler finished, the give-up after 5 deliveries, and that a deleted consumer is created again.

The chart is checked the way the pipeline checks it: `helm lint helm -f helm/values-dev.yaml` (and the prod values), and
`helm template market-maker helm -f helm/values-prod.yaml | kubeconform -strict` (also with `--set networkPolicy.enabled=true`).

## Layout (Clean Architecture)

| Folder | Holds | May import |
|---|---|---|
| `src/domain` | Units, the book, the offers, the pricing, the reading of an event; no I/O | nothing outside the domain |
| `src/usecases` | The quote run, the reaction to an event, the periodic check; the ports (interfaces) | the domain |
| `src/adapters` | The NATS consumers and message handlers, the periodic-check scheduler, the trading client with its token provider, the runtime-file watcher, the metrics module with the quote-run counters, the clock and delay, an in-memory trading client for local runs and tests | use cases and domain |
| `src/web` | The health routes | use cases and domain |
| `src/main.ts` | Composition root: configuration, adapters, use cases, consumers, scheduler, server | everything |
| `src/config.ts`, `src/shutdown.ts`, `src/logger.ts` | Typed configuration, the shutdown sequence (its steps are passed in, so it is tested with fake timers), the structured logger (secrets redacted) | the logger port |
| `contracts` | AsyncAPI of the consumed events, the outgoing contract to trading, and unchanged copies of the other services' contracts | |
| `helm` | Chart with dev and prod values, a watched runtime ConfigMap and a `helm test` smoke test | |

The lint fails when an inner layer imports an outer one.

## Delivery

Pull requests run lint, type check, tests with coverage, chart checks and an image build; a merge to `main` builds the image
once, pushes it to Docker Hub and deploys it to the prod namespace with Helm, followed by the smoke test and an automatic
rollback on failure. The steps live in the organization's shared workflow; see
[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml). The image holds `dist/` and the production dependencies and
runs as a non-root user on a read-only file system.

The chart (`helm`) creates a Deployment (one Pod, `Recreate`), a Service, the environment ConfigMap, the runtime ConfigMap, a
`helm test` smoke test and, when `networkPolicy.enabled` is set, a NetworkPolicy. The Service exists only so the smoke test
can reach `GET /health/ready` by name; nothing else routes to the bot. The Secret `market-maker-env`
(`MARKET_MAKER_CLIENT_SECRET`) is created by the pipeline from the organization secret `MARKET_MAKER_ENV` and is never part
of the chart. The NetworkPolicy admits only the release's smoke-test Pod to the HTTP port, the namespace
`networkPolicy.metrics.namespace` (default `monitoring`) to the metrics port, and lets the Pod reach only
trading's internal port (`trading.port`, 8081), NATS (4222), the identity provider (8080) and DNS (53).

## What it needs

- **Trading**, on its internal port 8081: `GET /v1/internal/markets`, `GET` and `PUT /v1/internal/markets/{id}/bot-book` and
  `bot-orders` (contract [`contracts/outgoing/trading-bot.openapi.yaml`](contracts/outgoing/trading-bot.openapi.yaml)). Its
  chart's `internal.allowedApps` already lists `market-maker`, and its `MARKET_MAKER_CLIENT_ID` has to match this service's.
- **NATS with JetStream**: the streams `MARKETS` (created by markets) and `TRADING` (created by trading). The bot creates
  only its own durable consumers, never a stream.
- **The identity provider**: a client-credentials token for the client `market-maker`.
- **The markets service**, whose events announce the markets to quote.

## Follow-ups

Recorded, not built here:

- **Keycloak client `market-maker`.** In the identity provider's realm: confidential, service account on, audience `chance`,
  claim `azp` = `market-maker`; its secret goes into the organization secret `MARKET_MAKER_ENV` as
  `MARKET_MAKER_CLIENT_SECRET` before the first deploy.
- **ADR-057 (Proposed).** Decide it (constant-product pricing); Q-18 (b) and (c) then point at it.
- **NATS permissions.** The bot's NATS user needs to create and consume the durable consumer `market-maker` on the streams
  `MARKETS` and `TRADING`; both exist only after their publishers ran.
- **Kill switch and resting offers.** Should `QUOTING_ENABLED=false` also withdraw the resting offers (an empty replacement
  everywhere)? Now it does not: they stay and keep filling.
- **Starting prices (markets).** Should markets restrict starting prices to 0.02..0.98, so every market opens two-sided at the
  default spread? Now this is documented only (see "Pricing").
- **Chart.** The NetworkPolicy is off by default: it needs a network policy engine in the cluster, and the labels in
  `networkPolicy.egress` must match the trading, NATS and identity Pods.
- **Delivery.** The repository secret `MARKET_MAKER_ENV` has to exist before the first deploy, and the Docker image is not
  built locally (the pull-request pipeline builds it).
