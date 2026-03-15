# Cipher Pol — Progress

Last updated: 2026-03-15

## Status: SUBMISSION-READY (devnet verified, landing page live)

---

## What's Done

### Rename (complete, 2026-03-15)
- Wraith Protocol → Cipher Pol across all source files
- Package: `wraith-agent` → `cipher-pol-agent`, `wraith-server` → `cipher-pol-server`
- GitHub repo renamed: Yonkoo11/cipher-pol
- Landing page URL: https://yonkoo11.github.io/cipher-pol/
- All test files, README, THREAT_MODEL.md, CLAUDE.md updated

### Tests (all passing, 2026-03-12, re-confirmed post-rename)
| Test | Count | Status |
|------|-------|--------|
| onchain.test.mjs | 8/8 | PASS — devnet deploy, deposit, prove, withdraw |
| server.test.mjs | 13/13 | PASS — middleware, 402 flow, nullifier dedup |
| integration.test.mjs | 26/26 | PASS — circuit, Merkle, proof gen, serialization |
| e2e.test.mjs | 28/28 | PASS — full HTTP x402 challenge → ZK proof → 200 |
| withdrawal.test.mjs | 7/7 phases | PASS — garaga calldata 2918 felts, on-chain withdraw |
| lit.test.mjs | 3/3 pass | PARTIAL — decrypt/access control unverified (see below) |

### Key Bug Fixes (2026-03-12, committed)
1. deposit() calldata: was passing full commitment; should pass hash(secret, nullifier) only
2. fetchAllDeposits(): misread Deposit event structure
3. extractPublicInputs(): no bounds check on zkProof array
4. Signal indices: refundCommitmentHash=4, amount=5 (were reversed)
5. serializeProofToFelts(): BigInt("0x" + decimal) prepended hex prefix to decimal strings
   → garaga is_on_curve rejected them. Fixed to BigInt(coord) directly.

### Cairo / Circuit
- scarb build passes, produces cipher_pol_*.contract_class.json
- Groth16 circuit: 14,282 constraints, 24-level Merkle tree
- garaga 0.15.3 calldata: 2918 felts, accepted by deployed verifier
- VERIFIER_CASM_HASH: 0x5a4520f3c48d98c3090e68df7aee9e60e2c28543fe8b1ce8d25152caecb5906

### Lit Protocol (partial)
- Steps 1-3 verified: connect to Datil, encryptString, getSessionSigs SIWE
- Steps 4-5 UNVERIFIED: decrypt + access control enforcement
- Blocker: Chronicle Yellowstone faucet non-functional, Datil sunsets 2026-04-01
- Action needed: migrate to Lit v3 Chipotle (not done — optional feature, not on critical path)

### Frontend
- Deployed: https://yonkoo11.github.io/cipher-pol/
- OG/Twitter meta tags added
- All GitHub links point to cipher-pol repo
- Removed dev preview files (preview.html, preview-d1/d2/d3.html)
- Removed dev Playwright scripts

---

## What's NOT Done

1. **Lit decrypt** — unverified, Datil sunset April 1, Chipotle migration needed
2. **Testnet/mainnet deployment** — devnet only (starknet-devnet 0.7.2, seed 42)
3. **STRK20Adapter** — stub; STRK20 announced 2026-03-10, technical spec pending
4. **1-party trusted setup** — need MPC ceremony for production
5. **RapidSnark** — snarkjs WASM is 4-6s; RapidSnark would be ~100ms
6. **Production nullifier set** — in-memory only, lost on restart
7. **Demo video** — deferred
8. **Hackathon submission form** — not started
9. **CI/CD** — no GitHub Actions

---

## Run Order (devnet tests)

```bash
starknet-devnet --seed 42 &
node scripts/rpc-proxy.mjs &
node tests/onchain.test.mjs
node tests/server.test.mjs
node tests/integration.test.mjs
node tests/e2e.test.mjs
node tests/withdrawal.test.mjs
```

## Recent Commits

```
be8bcaf — doc: record Datil sunset + Chipotle migration gap
4bbe06f — fix: lit test — always attempt step 5, increase retries
99711d3 — chore: clean repo + fix remaining stale branding
fc090c9 — fix: complete rename — README, landing page URLs
078dacc — fix: sync VERIFIER_CASM_HASH in e2e and withdrawal tests
71be5c1 — build: regenerate Cairo artifacts + verify rename end-to-end
a022dc2 — rename: Wraith Protocol → Cipher Pol across all source files
```
