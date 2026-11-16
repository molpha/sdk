---
"@molpha/sdk": minor
---

Source format: accept the optional absolute tolerance band `aggregation.maxDeviationAbs` (an unsigned integer string from 1 to 2^255 - 1 in raw output units), matching the node. A value is in band when the relative test holds or it is within `maxDeviationAbs` of the median. The key is omitted when unused, so existing sources keep their IDs. `defineSource`'s `aggregation` and `jsonPriceSource`'s `tolerance` take `maxDeviationAbs`.
