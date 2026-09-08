/**
 * Minimal Molpha verifier ABI for `verify` and registry reads.
 * Matches the deployed `verify(DataUpdate, SchnorrSignature)` verifier. The first tuple
 * component carries the 32-byte source id (the contract source names it `jobId`;
 * component names do not affect ABI encoding).
 */
export const MOLPHA_VERIFIER_ABI = [
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      {
        name: "dataUpdate",
        type: "tuple",
        components: [
          { name: "sourceId", type: "bytes32" },
          { name: "registryVersion", type: "uint32" },
          { name: "signaturesRequired", type: "uint32" },
          { name: "value", type: "bytes32" },
          { name: "canonicalTimestamp", type: "uint64" },
        ],
      },
      {
        name: "schnorrData",
        type: "tuple",
        components: [
          { name: "signature", type: "bytes32" },
          { name: "commitment", type: "address" },
          { name: "signersBitmap", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getRegistryVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "registryVersion", type: "uint256" }],
  },
] as const;
