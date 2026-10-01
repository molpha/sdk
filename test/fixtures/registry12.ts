/**
 * Registry secp256k1 pubkeys `(x, y)` of the immutable 12-node verifier fixture
 * (molpha-verifier tests/fixtures/mod.rs `PUBKEYS`; the registry the message golden vector
 * in message.test.ts is signed over). Public keys only.
 */
export const PUBKEYS: Array<{ x: string; y: string }> = [
  { x: "b9368548c5fb8611ce88af5f8afe4a4c0919718a1e3cdfca880e1c04add8118b", y: "b4524a87ce5b0064d67f6544d56f9b84e04b3425f157006ddc742a112f230791" },
  { x: "39604f6cc277d611732952bbde9e7d46ba233e979dfdc10f3e60be22606024ed", y: "47d1ae6168e867b47a1d068cdfd0e8eebb94399693522c31a0a1676e6d0ee8ff" },
  { x: "f96f19da7f28eabef62c7a8abb05d3f1a5f53f0edbe7bae35391737ec665f12d", y: "7bb1a48b1c0d37602782c74c0c8752fbe52351ccd7fc93d9f94ff6af101d0fd5" },
  { x: "d4e6aafb543f4649e802fddd92f9601df99bba5c439d269b61095a846e2c73a2", y: "a2e39e986dbf65beed056cca7eed46e96e8add885fee1aa5ce26d1d29635849d" },
  { x: "b28f931a8cd18af8f78d94d333696ef8385fa69ef6ff931af99b0b11d5016cc5", y: "19519ef8852eac100b4cd1bb3aae86dafeb2b63a9a3bd4e939c1d6e6768c036e" },
  { x: "fa327c1eca147a9f5de37564371b169f378e687da3f31ce55edf61132d4f693e", y: "3c4e1b545d29a518e63d32888c972f726cc558b1830ffea844107e189906ecf3" },
  { x: "d4ac64e8457c6c5b2a1f640b9ee5b4810ec756852ebbf73970a90a0699c64096", y: "472c9bd2cb0902ede24aff2c142826cfac1101c7a4bfbf080e490320a0fed6b7" },
  { x: "9867153de3ef5a676b4532a7d0bba72cb592558542213aaba1c25cff181e1eee", y: "a67373f491f974fe887cad30096e70c937fe1c2acfd3a30e8a161479c9dfb661" },
  { x: "a2141bab701d5d9c9f69738795cfdcea09c765b175958235acbb3e174fb32ec4", y: "efd7d7cdbbc9b3b4fc1fd7ce113fc598d4f7e0be4797f451d2331e80b365693c" },
  { x: "0395f19288a640369fb2dfa42c1f5dbc961068087fd84dca00fce941caa3e77b", y: "9e1021baf6dd19aa6df9d07eeda927ba4eb83a05acd127016be1158d84bd5a5e" },
  { x: "e5827a5aeb463137e84437d3acb00fdec63e717554c83e45977153d002f658e4", y: "e7f74fe2a077776ed480207d1a53099115cfc4f57d2a65750917230efd926c74" },
  { x: "eade2e589a7d2632a4c177a8d0174d9b0f1efb192f544adf43109b5c63b89a85", y: "9f83aad860a3a193033874f457388465f8b667f93e349e1851ab953c59f4f671" },
];

/**
 * Sums produced by the Rust verifier the Solana program links
 * (`molpha_verifier::coalition_key`, crate 0.3.0-dev.13 — the version pinned in the program's
 * Cargo.lock at 3d01170), run over PUBKEYS for the given signer bits. The first set is the
 * fixture's seven signers (`signersBitmap = 4008`).
 */
export const RUST_VECTORS: Array<{ signers: number[]; x: string; y: string }> = [
  {
    signers: [3, 5, 7, 8, 9, 10, 11],
    x: "a8909e4e17c086e7f5e9b7a85417974bdb4c0d666bdc80042f3095154c44bbc6",
    y: "fe60a98d0b831d36e533caa42d590cb2c6018afeb1b1f4f14481385776501970",
  },
  {
    signers: [0, 1, 2],
    x: "71de5d88d1fa486bdddec0d59d78328c299f71e6e933cf71bbebc08f8b78ec56",
    y: "c10444451819898ddf6c9070fbe3082ff1f23a36b69621e9e554a81545f5df61",
  },
  {
    signers: [4],
    x: "b28f931a8cd18af8f78d94d333696ef8385fa69ef6ff931af99b0b11d5016cc5",
    y: "19519ef8852eac100b4cd1bb3aae86dafeb2b63a9a3bd4e939c1d6e6768c036e",
  },
];

/** The fixture's seven signers (`signersBitmap = 4008`) and the round quorum it was signed with. */
export const FIXTURE_SIGNER_BITS = [3, 5, 7, 8, 9, 10, 11];
