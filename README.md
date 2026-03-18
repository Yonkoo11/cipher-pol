# Cipher Pol

ZK-native private payments for AI agents on Starknet.

An AI agent deposits into a shared pool. When it later pays an API server, it generates a Groth16 zero-knowledge proof that proves pool membership without revealing which deposit. The server verifies the proof, gets paid, and learns nothing about who paid.

Built on [x402](https://www.x402.org) (HTTP 402 payment protocol) and deployed on Starknet devnet. Created for the [PL_Genesis: Frontiers of Collaboration](https://pl-genesis-frontiers-of-collaboration-hackathon.devspot.app/) hackathon.

---

## The problem

Every time an AI agent pays for an API call on-chain, its address gets linked to the service, the amount, and the timestamp. Watch the chain and you can reconstruct what the agent is doing and who it's talking to.

x402 gives agents a payment rail. Cipher Pol makes sure the payment doesn't reveal who's paying.

---

## How it works

```
Agent                            Server
  │                                │
  │── GET /api ───────────────────>│
  │<── 402 Payment Required ───────│  { amount, poolAddress, challenge }
  │                                │
  │  generate Groth16 proof (~4s)  │  proves: "I own a note in this pool"
  │  private: secret, nullifier    │  without revealing: which deposit
  │  public:  root, nullifierHash  │
  │                                │
  │── POST /api ──────────────────>│
  │   X-Payment-Proof: <proof>     │── verify Groth16 proof (garaga on-chain)
  │                                │── check nullifier (prevent double-spend)
  │<── 200 OK ─────────────────────│── queue pool.withdraw() on Starknet
```

The proof is verified by a garaga 0.15.3 verifier deployed on Starknet. The nullifier is stored to prevent reuse.

---

## What's been verified

Tested against starknet-devnet 0.7.2 (seed 42):

- **8/8** on-chain tests — deposit → Groth16 proof → garaga calldata → `pool.withdraw()`
- **13/13** server middleware tests
- **26/26** SDK integration tests — circuit, Merkle tree, proof generation, serialization
- **28/28** HTTP x402 end-to-end tests — full 402 challenge → ZK proof → 200 flow
- **7/7** WithdrawalQueue phases — proof queuing, garaga calldata generation, on-chain withdrawal

---

## Running it

```bash
# Prerequisites: Node 20+, starknet-devnet, snarkjs

# 1. Start devnet
starknet-devnet --seed 42

# 2. Start RPC proxy (starknet.js compatibility)
node scripts/rpc-proxy.mjs &

# 3. Run tests in order
node tests/onchain.test.mjs       # deploy contracts, test on-chain flow
node tests/server.test.mjs        # middleware
node tests/integration.test.mjs   # SDK
node tests/e2e.test.mjs           # full HTTP x402 flow
node tests/withdrawal.test.mjs    # withdrawal queue + garaga
```

---

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `cipher-pol-agent` | `sdk/` | SDK for agents: deposit, generate ZK proofs, pay via x402 |
| `cipher-pol-server` | `server/` | Express middleware: verify proofs, prevent double-spend, queue withdrawals |

### Agent SDK

```ts
import { CipherPolAgent } from './sdk/src/agent';
import { Account, RpcProvider } from 'starknet';

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account  = new Account(provider, ADDRESS, PRIVATE_KEY);

const agent = new CipherPolAgent({
  adapter: 'privacy-pools',
  poolAddress: POOL_ADDRESS,
  starknetRpcUrl: RPC_URL,
  account,
});

// Deposit once
await agent.deposit(1_000_000n); // 1 STRK (18 decimals)

// Pay any x402-compatible API — no trace to your deposit address
const response = await agent.pay('https://api.example.com/v1/generate', {
  amount: 100n,
  token: 'STRK',
});
```

### Server middleware

```ts
import express from 'express';
import { cipherPolPaywall } from './server/src/middleware';

const app = express();

app.use('/v1/generate', cipherPolPaywall({
  amount: 100n,
  poolAddress: POOL_ADDRESS,
  account,        // server's Starknet account for withdrawals
  flushIntervalMs: 300_000,  // batch withdrawals every 5min (timing privacy)
}));
```

---

## Privacy model

| Property | Status |
|----------|--------|
| Deposit ↔ withdrawal link | Hidden by ZK proof |
| Depositor address | Visible on-chain at deposit time |
| Payment amount | Public on-chain |
| Which deposit funded the payment | Cryptographically hidden |
| Double-spend prevention | Nullifier hash stored on-chain |

**Anonymity set**: privacy scales with pool size. 3 depositors → 3-candidate set. Withdraw into a pool of 1 = no privacy.

---

## Known limits

1. **1-party trusted setup.** Local Powers of Tau. Not production. Needs an MPC ceremony.
2. **In-memory nullifier set.** Lost on server restart, which opens a double-spend window. Needs Redis for production.
3. **No relay.** Server operator sees nullifierHash + withdrawal tx, so they can build a correlation graph. Documented in THREAT_MODEL.md.
4. **Proof generation takes 4-6s.** snarkjs WASM. RapidSnark (~100ms) is not integrated yet.
5. **Partial withdrawals blocked.** The circuit supports them via `refundCommitmentHash`, but there's no `claimRefund()` path in v1. Attempting one returns a hard error.
6. **BN254 is not quantum-resistant.** The v2 path is STARK proofs on Starknet's native hash.

See [`THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the full analysis.

---

## Stack

- **Circuit**: Circom 2 + Groth16/BN254 + Poseidon
- **On-chain verifier**: garaga 0.15.3 (Starknet)
- **Proof generation**: snarkjs WASM
- **Payment protocol**: x402 (HTTP 402)
- **Chain**: Starknet (Cairo contracts)

---

## License

MIT
