---
"@molpha/sdk": patch
---

Source policies (node-client docs/policy.md).

- `parseSource` accepts the optional `policy` block: candidates with per-input rules, a combinator (`single`,
  `median`, `weightedMedian`, `allEqual`, `majority`, `fallback`, `primaryPlusOne`), independence,
  `inconclusiveIf` and `inconclusive: { fallback }`; the references `$tsMs`, `$value`, `$agg`, `$n` and, in a
  fallback, `$reason`; the operators `and`, `or`, `not` and `in`; a 128-node budget with a policy. Held to the
  node client's `policy-vectors.json` and `analyze-vectors.json`.
- A policy's fallback is the value its nodes sign, under the source's own ID, when the policy concludes
  INCONCLUSIVE; without one they refuse. `fallbackWords(src)` lists the words it can sign, and
  `readOutcome(payload, src)` reads a verified attestation as the source's result or its fallback.
- `analyzeSource` returns the same static analysis as the node and gateway (inputs, hosts, chains, candidates,
  the fallback's values and whether a result can equal it, expression counts, capabilities, warnings).
- Builders: `sx.and`, `sx.or`, `sx.not`, `sx.inList`, and `SourceInput.policy` with every default written out
  (`policyDocFor`).
- `MolphaGateway.requestSignedData` adds `outcome` (`conclusive` or `fallback`) and `reason` for a source with
  a policy, and refuses a `fallback` label on a value the source does not declare as its fallback.
