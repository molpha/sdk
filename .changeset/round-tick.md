---
"@molpha/sdk": minor
---

Fixed 100 ms round tick.

**Breaking**

- The gateway stamps each round with its millisecond clock floored to a fixed 100 ms tick
  (`floor(nowMs / 100) * 100`). The tick is a protocol constant, the same on every gateway and
  node: it is not configurable and `GET /v1/info` does not report it. Nodes reject a round whose
  timestamp is off the grid.
- One feed (a source, a quorum and a registry version) runs at most 10 rounds per second. Requests
  for the same feed inside one tick share one round: the nodes run it once and every caller gets
  the result.
- One consumer gets one round per tick per feed. A second request by the same consumer for the same
  source and quorum inside the tick is HTTP 409.
- The `tickMs` option of `requestSignedData` and the `msUntilNextTick` export are removed, and
  `GatewayInfo` has no `tickMs`. `requestSignedData` makes no `/v1/info` call to plan a retry.
- `retryDelayMs(cause, failures, random?)` takes no clock and no tick. A 409 is retried after one
  full tick (`ROUND_TICK_MS`) plus up to 20 ms of jitter; a full tick puts the retry in a later tick
  whatever the offset between the client's clock and the gateway's, so no boundary is computed from
  the local clock. A 503 or 429 waits the later of the gateway's `Retry-After` and the backoff step
  (250 ms doubling to 5 s), plus up to one more step. Other transient failures wait the backoff
  step, half of it randomized. `maxRetries` bounds all of them.
- A retried request is a new round: it spends another unit of round quota or needs another payment,
  and with a paywalled source another set of payment authorizations. Nothing ties a retry to the
  attempt before it.
- The gateway limits the total load: at capacity it answers HTTP 503 with a `Retry-After`, a
  consumer over its request rate gets HTTP 429, and a round too few nodes accepted is a 503 too.
  `requestSignedData` retries them with backoff and throws a `GatewayError` carrying the status
  when the attempts run out.

**Added**

- `ROUND_TICK_MS` (100): the round tick in milliseconds.
- `MolphaGatewayOptions.sleep`: the wait between attempts, injectable for tests (as `random` is).
