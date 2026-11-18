---
"@molpha/sdk": patch
---

Source policies (node-client docs/policy.md).

- `parseSource` accepts the optional `policy` block: candidates with per-input rules, a combinator (`single`,
  `median`, `weightedMedian`, `allEqual`, `majority`, `fallback`, `primaryPlusOne`), independence,
  `inconclusiveIf` and `inconclusive: sign|refuse`; the references `$tsMs`, `$value`, `$agg` and `$n`; the
  operators `and`, `or`, `not` and `in`; a 128-node budget with a policy. Held to the node client's
  `policy-vectors.json` and `analyze-vectors.json`.
- `analyzeSource` returns the same static analysis as the node and gateway (inputs, hosts, chains, candidates,
  expression counts, capabilities, warnings).
- `inconclusiveId(S)` derives `I(S) = keccak256("MOLPHA_INCONCLUSIVE_V1" || S)`, the ID a policy's INCONCLUSIVE
  result is signed under; `readOutcome(payload, S)` reads a verified attestation as the result (under `S`) or a
  reason (under `I(S)`), and `null` for anything else.
- Builders: `sx.and`, `sx.or`, `sx.not`, `sx.inList`, and `SourceInput.policy` with every default written out
  (`policyDocFor`).
- `MolphaGateway.requestSignedData` accepts an attestation under `I(S)` for a source with `inconclusive: sign`
  only, renders its value as the reason instead of the source's output, and adds `outcome`, `reason` and
  `roundSourceId` for a source with a policy.
