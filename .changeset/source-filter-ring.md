---
"@molpha/sdk": minor
---

Source format: accept JSON filters with 2 to 4 terms joined by ` && ` (`[?(@.LineNumber=='2' && @.TimePeriod=='2026Q2')]`) and layout ring fields (`ring: {index, back, len, stride}`, one slot of a ring buffer such as a Raydium CLMM or Meteora DLMM observation array), matching the node. `layoutDecode` takes an optional `ring` per field.
