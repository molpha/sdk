---
"@molpha/sdk": minor
---

`simulateSource()` (and `MolphaGateway.simulateSource()`): evaluate a source over inputs you supply on a
gateway's `POST /v1/source/simulate`, with the nodes' own evaluator. Each input is an http `body`, decoded
`fields` (a chain input with its `block`), or an `error`; nothing is fetched, signed or charged, so a
policy's outcome and fallback can be checked against any data. Results of `requestSignedData` carry
`roundId`, derived from the signed payload: the key of the round's archive page and, for a policy source,
each node's receipt of it.
