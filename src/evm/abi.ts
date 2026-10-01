/**
 * Molpha EVM verifier ABI: `verify(Attestation, uint64 maxAge) -> (bool, uint8)` plus every
 * read-only registry view on `IVerifier`. Owner-only mutators (`addNode`, `removeNode`,
 * `setRedundancyBuffer`) and `Ownable` plumbing are deliberately left out.
 *
 * Mirrors `IVerifier.sol` in `molpha-core-contracts`. Struct member order is ABI-significant
 * and equals the signed message order, so it is not the flat gateway field order on `Attestation`.
 */
export const MOLPHA_VERIFIER_ABI = [
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      {
        name: "attestation",
        type: "tuple",
        internalType: "struct IVerifier.Attestation",
        components: [
          {
            name: "payload",
            type: "tuple",
            internalType: "struct IVerifier.AttestationPayload",
            components: [
              { name: "value", type: "bytes32", internalType: "bytes32" },
              { name: "sourceId", type: "bytes32", internalType: "bytes32" },
              { name: "registryVersion", type: "uint32", internalType: "uint32" },
              { name: "signaturesRequired", type: "uint8", internalType: "uint8" },
              { name: "canonicalTimestamp", type: "uint64", internalType: "uint64" },
            ],
          },
          {
            name: "signature",
            type: "tuple",
            internalType: "struct IVerifier.SchnorrSignature",
            components: [
              { name: "signature", type: "bytes32", internalType: "bytes32" },
              { name: "commitment", type: "address", internalType: "address" },
              { name: "signersBitmap", type: "uint256", internalType: "uint256" },
            ],
          },
        ],
      },
      { name: "maxAge", type: "uint64", internalType: "uint64" },
    ],
    outputs: [
      { name: "success", type: "bool", internalType: "bool" },
      { name: "code", type: "uint8", internalType: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getRegistryVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "registryVersion", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "getTotalNodes",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "totalNodes", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "redundancyBuffer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "getRegistryRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "root", type: "bytes32", internalType: "bytes32" }],
  },
  {
    type: "function",
    name: "getRegistryRoot",
    stateMutability: "view",
    inputs: [{ name: "registryVersion", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "root", type: "bytes32", internalType: "bytes32" }],
  },
  {
    type: "function",
    name: "getRegistryPointer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "registryPointer", type: "address", internalType: "address" }],
  },
  {
    type: "function",
    name: "getRegistryPointer",
    stateMutability: "view",
    inputs: [{ name: "registryVersion", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "registryPointer", type: "address", internalType: "address" }],
  },
  {
    type: "function",
    name: "activatesAt",
    stateMutability: "view",
    inputs: [{ name: "registryVersion", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "ts", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "retiredAt",
    stateMutability: "view",
    inputs: [{ name: "registryVersion", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "ts", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "isLatestVersion",
    stateMutability: "view",
    inputs: [{ name: "registryVersion", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "latest", type: "bool", internalType: "bool" }],
  },
  {
    type: "function",
    name: "nodeStatus",
    stateMutability: "view",
    inputs: [{ name: "node", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
  },
  {
    type: "function",
    name: "isNode",
    stateMutability: "view",
    inputs: [{ name: "node", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
  },
  /** Thrown by the per-version views for a version that was never published. `verify` never reverts. */
  { type: "error", name: "InvalidRegistryVersion", inputs: [] },
] as const;
