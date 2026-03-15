# Cipher Pol — Architecture Memory

Last updated: 2026-03-15 (post-rename, post-architecture-fix)

## What We Are Building

Agent SDK for private AI payments on Starknet. NOT a new privacy pool.
npm package: `cipher-pol-agent` | server: `cipher-pol-server`

## Adapter Pattern

```
cipher-pol-agent
├── PrivacyPoolsAdapter  LIVE — Ekubo pool, Groth16, depositor visible at deposit time
├── STRK20Adapter        STUB — STRK20 announced 2026-03-10, not yet public
├── PaymentBatcher       60s windows, amount bucketing
├── ReceiptVault         Storacha/Filecoin + Lit Protocol (written, not deployed)
└── Integrations         x402, LangChain (examples written)
```

## Payment Flow (v1 — CURRENT, CORRECT)

```
1. Agent generates (secret, nullifier) locally — NEVER sent to server
2. deposit(hash(secret, nullifier), amount) on-chain — agent address visible at deposit
3. Agent waits (anonymity set grows with more deposits)
4. Agent generates Groth16 proof locally:
     Private: secret, nullifier, pathElements[24], pathIndices[24]
     Public:  root, nullifierHash, recipient, amount
5. Agent sends ONLY { zkProof, nullifierHash, publicInputs } to server via x402
6. Server checks: recipient matches, amount sufficient, nullifier not spent
7. Server queues pool.withdraw(garaga_calldata) to Starknet — does NOT learn depositor
```

**What server learns**: amount, timing, nullifierHash. NOT the depositor address or which deposit.
**What chain sees**: deposit address at deposit time (public), withdrawal recipient (public). Deposit↔withdrawal link hidden.

NOTE: Pre-v1 design had the server receiving (secret, nullifier) via Lit to generate the proof.
That was a fundamental privacy flaw (server learned both deposit and withdrawal). It was removed.
Do NOT restore that pattern.

## Ekubo Privacy Pool Interface

```cairo
fn deposit(secret_and_nullifier_hash: u256, amount: u256) -> bool
fn withdraw(proof: Span<felt252>) -> bool  // garaga 0.15.3 calldata (~2918 felts)
fn current_root() -> u256
// Events
Deposit(caller, secret_and_nullifier_hash, amount)  // caller IS visible
Withdrawal(caller, recipient, amount, associated_set_root)
```

Pool computes `commitment = hash(secret_and_nullifier_hash, amount)` internally.
deposit() takes hash(secret, nullifier) — NOT the full commitment.

## Critical Implementation Notes

### Proof Serialization (toBigInt bug, fixed 2026-03-12)
snarkjs returns coordinates as decimal strings (`F.toObject()` → `o.toString(10)`).
DO NOT prepend "0x". Use `BigInt(coord)` not `BigInt("0x" + coord)`.
The "0x" prefix on a decimal string produces wrong BN254 field values — garaga's
`is_on_curve` check rejects them with "ValueError: Point not on curve CurveID.BN254".

### Public Signal Indices (fixed 2026-03-12)
snarkjs orders public signals by definition position in component body, NOT the main
`public []` declaration. In pool.circom, refundCommitmentHash is defined before amount:
- Index 4 = refundCommitmentHash
- Index 5 = amount
Using the wrong order causes "Proof amount 0 < required X" on every real proof.

### Poseidon Hash Compatibility
poseidon-lite matches Ekubo's circuit parameters exactly. Verified numerically.
`nullifierHash = poseidon2([nullifier, nullifier])` — HashOne(x) = Hash([x, x]).

## Privacy Guarantees (Honest)

v1 (Ekubo pool):
- Depositor address IS VISIBLE at deposit time
- Deposit↔withdrawal link IS HIDDEN via ZK (Groth16/BN254, NOT quantum-resistant)
- Anonymity set = number of deposits in pool (tiny on devnet, demo-grade)

v2 (STRK20, when repo ships):
- ZK-native, no anonymity floor required
- Stwo STARKs = quantum-resistant
- Compliance via viewing keys

## Verified Test Results (2026-03-12, re-confirmed 2026-03-15)

| Test | Count | Status |
|------|-------|--------|
| onchain.test.mjs | 8/8 | PASS |
| server.test.mjs | 13/13 | PASS |
| integration.test.mjs | 26/26 | PASS |
| e2e.test.mjs | 28/28 | PASS |
| withdrawal.test.mjs | 7/7 phases | PASS |
| lit.test.mjs | 3/3 pass, 2 skipped | PARTIAL |

Lit steps 4-5 (decrypt, access control) blocked: capacity credits require tstLPX,
Chronicle Yellowstone faucet non-functional, Datil sunsets 2026-04-01.
Migration to Lit v3 Chipotle needed for full verification.

## Deployment

- GitHub: https://github.com/Yonkoo11/cipher-pol
- Landing page: https://yonkoo11.github.io/cipher-pol/
- Devnet only. No testnet/mainnet deployment.

## Judges / Partners

- David Sneider (Lit Protocol co-founder) = judge → ReceiptVault integration is relevant
- 0xbow open to SDK integration
- Mist.cash open to partnership

## Competitors

- Cloak (Karnot + Tongo): agent orchestration + private x402. One on-chain tx per payment.
- Cipher Pol diff: ZK proof unlinking (not just transport privacy) + open SDK

## Known Architectural Limits

1. 1-party trusted setup — not production. Need MPC ceremony.
2. In-memory nullifier set — lost on restart. Redis needed.
3. No relay — server operator sees nullifierHash + withdrawal tx.
4. snarkjs WASM — 4-6s per proof. RapidSnark would be ~100ms.
5. BN254 not quantum-resistant. v2 path: STARK proofs.
6. Partial withdrawals blocked — circuit supports refundCommitmentHash but no claimRefund() path.
