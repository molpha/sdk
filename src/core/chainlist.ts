/**
 * The published chain list: for each chain its CAIP-2 id, kind, block time, the finality modes (or
 * commitments) it offers and their bounds. Generated from the node client's `new/source/chainlist.json`,
 * which is the reference; the numbers are protocol estimates, not measurements of a live chain.
 */
export interface Chain {
  id: string;
  kind: "evm" | "starknet" | "svm";
  name: string;
  /** evm and starknet only. */
  blockTimeMs?: number;
  /** evm and starknet: the finality modes offered, with their bounds. */
  finality?: Record<string, { minLagMs?: number; maxN?: number }>;
  maxLagMs?: number;
  /** svm: the commitments offered. */
  commitments?: Record<string, { minMaxAgeMs: number }>;
  maxMaxAgeMs?: number;
}

export const CHAIN_LIST: Chain[] = [
  {
    id: "eip155:1",
    kind: "evm",
    name: "Ethereum",
    blockTimeMs: 12000,
    finality: {
      finalized: {
        minLagMs: 900000,
      },
      safe: {
        minLagMs: 480000,
      },
      confirmations: {
        maxN: 64,
      },
    },
    maxLagMs: 1500000,
  },
  {
    id: "eip155:11155111",
    kind: "evm",
    name: "Ethereum Sepolia",
    blockTimeMs: 12000,
    finality: {
      finalized: {
        minLagMs: 900000,
      },
      safe: {
        minLagMs: 480000,
      },
      confirmations: {
        maxN: 64,
      },
    },
    maxLagMs: 1500000,
  },
  {
    id: "eip155:8453",
    kind: "evm",
    name: "Base",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:84532",
    kind: "evm",
    name: "Base Sepolia",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:42161",
    kind: "evm",
    name: "Arbitrum One",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:10",
    kind: "evm",
    name: "OP Mainnet",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:137",
    kind: "evm",
    name: "Polygon PoS",
    blockTimeMs: 2000,
    finality: {
      finalized: {
        minLagMs: 15000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:56",
    kind: "evm",
    name: "BNB Smart Chain",
    blockTimeMs: 500,
    finality: {
      finalized: {
        minLagMs: 5000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 60000,
  },
  {
    id: "eip155:43114",
    kind: "evm",
    name: "Avalanche C-Chain",
    blockTimeMs: 2000,
    finality: {
      finalized: {
        minLagMs: 5000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:59144",
    kind: "evm",
    name: "Linea",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:534352",
    kind: "evm",
    name: "Scroll",
    blockTimeMs: 3000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 360000,
  },
  {
    id: "eip155:324",
    kind: "evm",
    name: "ZKsync Era",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:81457",
    kind: "evm",
    name: "Blast",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:5000",
    kind: "evm",
    name: "Mantle",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:130",
    kind: "evm",
    name: "Unichain",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:42220",
    kind: "evm",
    name: "Celo",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:1329",
    kind: "evm",
    name: "Sei",
    blockTimeMs: 500,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 60000,
  },
  {
    id: "eip155:999",
    kind: "evm",
    name: "HyperEVM",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:143",
    kind: "evm",
    name: "Monad",
    blockTimeMs: 500,
    finality: {
      finalized: {
        minLagMs: 5000,
      },
      safe: {
        minLagMs: 3000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 60000,
  },
  {
    id: "eip155:4326",
    kind: "evm",
    name: "MegaETH",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:421614",
    kind: "evm",
    name: "Arbitrum Sepolia",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:11155420",
    kind: "evm",
    name: "OP Sepolia",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:80002",
    kind: "evm",
    name: "Polygon Amoy",
    blockTimeMs: 2000,
    finality: {
      finalized: {
        minLagMs: 15000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:97",
    kind: "evm",
    name: "BNB Smart Chain Testnet",
    blockTimeMs: 500,
    finality: {
      finalized: {
        minLagMs: 5000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 60000,
  },
  {
    id: "eip155:43113",
    kind: "evm",
    name: "Avalanche Fuji",
    blockTimeMs: 2000,
    finality: {
      finalized: {
        minLagMs: 5000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:59141",
    kind: "evm",
    name: "Linea Sepolia",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:300",
    kind: "evm",
    name: "ZKsync Sepolia",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:168587773",
    kind: "evm",
    name: "Blast Sepolia",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:5003",
    kind: "evm",
    name: "Mantle Sepolia",
    blockTimeMs: 2000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 240000,
  },
  {
    id: "eip155:1301",
    kind: "evm",
    name: "Unichain Sepolia",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:11142220",
    kind: "evm",
    name: "Celo Sepolia",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:1328",
    kind: "evm",
    name: "Sei Testnet",
    blockTimeMs: 500,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 60000,
  },
  {
    id: "eip155:998",
    kind: "evm",
    name: "HyperEVM Testnet",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "eip155:10143",
    kind: "evm",
    name: "Monad Testnet",
    blockTimeMs: 500,
    finality: {
      finalized: {
        minLagMs: 5000,
      },
      safe: {
        minLagMs: 3000,
      },
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 60000,
  },
  {
    id: "eip155:6343",
    kind: "evm",
    name: "MegaETH Testnet",
    blockTimeMs: 1000,
    finality: {
      confirmations: {
        maxN: 60,
      },
    },
    maxLagMs: 120000,
  },
  {
    id: "starknet:SN_MAIN",
    kind: "starknet",
    name: "Starknet",
    blockTimeMs: 6000,
    finality: {
      finalized: {
        minLagMs: 21600000,
      },
      confirmations: {
        maxN: 100,
      },
    },
    maxLagMs: 86400000,
  },
  {
    id: "starknet:SN_SEPOLIA",
    kind: "starknet",
    name: "Starknet Sepolia",
    blockTimeMs: 6000,
    finality: {
      finalized: {
        minLagMs: 21600000,
      },
      confirmations: {
        maxN: 100,
      },
    },
    maxLagMs: 86400000,
  },
  {
    id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    kind: "svm",
    name: "Solana mainnet",
    commitments: {
      finalized: {
        minMaxAgeMs: 20000,
      },
      confirmed: {
        minMaxAgeMs: 10000,
      },
    },
    maxMaxAgeMs: 3600000,
  },
  {
    id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    kind: "svm",
    name: "Solana devnet",
    commitments: {
      finalized: {
        minMaxAgeMs: 20000,
      },
      confirmed: {
        minMaxAgeMs: 10000,
      },
    },
    maxMaxAgeMs: 3600000,
  },
];
