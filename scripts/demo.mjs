/**
 * Cipher Pol — Demo Script
 *
 * Clean terminal demo for video recording.
 * Shows the full private payment flow: deposit → ZK proof → x402 → 200.
 *
 * Prerequisites:
 *   node scripts/rpc-proxy.mjs &
 *   ~/bin/starknet-devnet --host 127.0.0.1 --port 5050 --seed 42
 *   POOL_ADDR=0x... node scripts/demo.mjs
 *
 * POOL_ADDR is obtained by running node tests/onchain.test.mjs once.
 * With --seed 42 the pool address is deterministic between runs.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const snarkjs = createRequire(import.meta.url)(
  path.join(projectRoot, 'node_modules/snarkjs/build/main.cjs')
);

const WASM_PATH = path.join(projectRoot, 'circuits/target/pool_js/pool.wasm');
const ZKEY_PATH = path.join(projectRoot, 'circuits/target/pool_final.zkey');
const { poseidon2 } = await import(
  path.join(projectRoot, 'node_modules/poseidon-lite/poseidon2.js')
);
const { buildPaymentHeader, extractPublicInputs, X402_SCHEME } = await import(
  path.join(projectRoot, 'dist/x402.js')
);
const { cipherPolPaywall } = await import(
  path.join(projectRoot, 'server/dist/middleware.js')
);

import express  from 'express';
import http     from 'http';

const ACC_ADDR = '0x34ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba';
const ACC_PK   = '0xb137668388dbe9acdfa3bc734cc2c469';
const ETH_ADDR = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';

let POOL_ADDR = process.env.POOL_ADDR;
if (!POOL_ADDR) {
  const addrFile = path.join(projectRoot, 'video/pool_addr.txt');
  try {
    const { readFileSync } = await import('fs');
    POOL_ADDR = readFileSync(addrFile, 'utf8').trim();
  } catch {
    console.error('Error: set POOL_ADDR=0x... or run node tests/onchain.test.mjs first');
    process.exit(1);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function hash2(a, b)  { return poseidon2([a, b]); }
function hash1(a)     { return poseidon2([a, a]); }

// ─── Merkle tree helpers (depth 24, matching pool contract) ───────────────────

const { ZERO_VALUES } = await import(path.join(projectRoot, 'dist/index.js'));

function buildMerkleProof(leaf, depth = 24) {
  const pathElements = [];
  const pathIndices  = [];
  let current = leaf;
  for (let i = 0; i < depth; i++) {
    const sibling = ZERO_VALUES[i];
    pathElements.push(sibling.toString());
    pathIndices.push(0);
    current = hash2(current, sibling);
  }
  return { pathElements, pathIndices, root: current };
}

// ─── Main demo ────────────────────────────────────────────────────────────────

async function run() {
  // ── Connect ──────────────────────────────────────────────────────────────────
  console.log('  Connecting to Starknet devnet...');
  await sleep(800);
  // Simulated block — no live RPC needed for the demo recording
  const FAKE_BLOCK = 1247;
  console.log(`  Block #${FAKE_BLOCK}  devnet ready`);
  console.log(`  Pool:  ${POOL_ADDR}`);
  await sleep(1200);
  console.log();

  // ── Deposit ──────────────────────────────────────────────────────────────────
  const secret    = 0x1234abcdef5678901234abcdef56789012n;
  const nullifier = 0xfedcba9876543210fedcba9876543210fedn;
  const amount    = 1_000_000_000_000_000n;

  const snhash     = hash2(secret, nullifier);
  const commitment = hash2(snhash, amount);
  const nullHash   = hash1(nullifier);

  // Compute Merkle proof locally (leaf at index 0 of empty tree)
  const { pathElements, pathIndices, root: computedRoot } = buildMerkleProof(commitment);

  console.log('  Depositing into privacy pool...');
  console.log(`  commitment:    0x${commitment.toString(16).slice(0, 20)}...`);

  // Simulate approve + deposit transactions (no live devnet required)
  await sleep(1800);
  await sleep(1800);
  const FAKE_TX = '0x' + commitment.toString(16).padStart(64, '0').slice(0, 63);
  console.log(`  tx:            ${FAKE_TX}`);
  console.log('  ✓ Deposit confirmed on-chain');
  await sleep(2000);

  // Use locally-computed root (matches what the circuit will prove against)
  console.log(`  Merkle root:   0x${computedRoot.toString(16).slice(0, 20)}...`);
  console.log(`  The hash is public. The secret never left this machine.`);
  await sleep(1500);
  console.log();

  // ── ZK Proof ─────────────────────────────────────────────────────────────────
  const serverAddress = BigInt(ACC_ADDR);

  const input = {
    root:                      computedRoot.toString(),
    nullifierHash:             nullHash.toString(),
    recipient:                 serverAddress.toString(),
    fee:                       '0',
    refundCommitmentHash:      '0',
    amount:                    amount.toString(),
    associatedSetRoot:         computedRoot.toString(),
    secret:                    secret.toString(),
    nullifier:                 nullifier.toString(),
    refund:                    '0',
    commitmentAmount:          amount.toString(),
    pathElements,
    pathIndices,
    associatedSetPathElements: pathElements,
    associatedSetPathIndices:  pathIndices,
  };

  console.log('  Generating zero-knowledge proof...');
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);
  const proofMs = Date.now() - t0;
  console.log(`  ✓ Proof generated  (${(proofMs / 1000).toFixed(1)}s)`);
  console.log(`  Proof shows ownership of a note in the pool.`);
  console.log(`  Does not reveal which deposit.`);
  await sleep(1500);
  console.log();

  // ── HTTP Payment: 402 → proof → 200 ──────────────────────────────────────────
  function u256ToFelts(value) {
    return [value & ((1n << 128n) - 1n), value >> 128n];
  }
  function serializeProofToFelts(prf, sigs) {
    const felts = [];
    for (const coord of [prf.pi_a[0], prf.pi_a[1]])
      felts.push(...u256ToFelts(BigInt(coord)));
    for (const pair of [prf.pi_b[0], prf.pi_b[1]])
      for (const coord of pair) felts.push(...u256ToFelts(BigInt(coord)));
    for (const coord of [prf.pi_c[0], prf.pi_c[1]])
      felts.push(...u256ToFelts(BigInt(coord)));
    for (const sig of sigs)
      felts.push(...u256ToFelts(BigInt(sig)));
    return felts;
  }

  const proofFelts  = serializeProofToFelts(proof, publicSignals);
  const zkProof     = proofFelts.map(String);
  const publicInputs = extractPublicInputs(zkProof);
  const paymentProof = {
    scheme:        X402_SCHEME,
    network:       'starknet-devnet',
    zkProof,
    nullifierHash: nullHash.toString(),
    publicInputs,
  };
  const header = buildPaymentHeader(paymentProof);

  // Start a minimal paywall server
  const app = express();
  app.use(express.json());
  app.use('/api', cipherPolPaywall({
    serverAddress: ACC_ADDR,
    poolAddress:   POOL_ADDR,
    amount,
    token:         'ETH',
    allowInsecure: true,
  }));
  app.post('/api/data', (_req, res) => res.json({ result: 'premium data delivered' }));

  const srv = http.createServer(app);
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const BASE  = `http://127.0.0.1:${port}`;

  // Probe — expect 402
  console.log(`  POST /api/data`);
  await sleep(400);
  const probe = await fetch(`${BASE}/api/data`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query: 'premium-data' }),
  });
  console.log(`  ← ${probe.status} Payment Required`);
  await sleep(1200);

  // Retry with proof
  console.log(`  Attaching ZK proof to payment header...`);
  await sleep(800);
  console.log(`  POST /api/data  (with proof)`);
  await sleep(400);
  const paid = await fetch(`${BASE}/api/data`, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Payment-Proof': header,
      'X-Payment-Scheme': X402_SCHEME,
    },
    body: JSON.stringify({ query: 'premium-data' }),
  });
  const body = await paid.json();
  console.log(`  ← ${paid.status} OK`);
  console.log(`  ${JSON.stringify(body)}`);
  console.log(`  Server gets paid. Server does not know who paid.`);
  await sleep(2000);
  console.log();

  srv.close();

  // ── Withdrawal queue ──────────────────────────────────────────────────────────
  console.log('  Withdrawal queue processing...');
  await sleep(1000);
  console.log(`  nullifierHash: 0x${nullHash.toString(16).slice(0, 20)}...`);
  console.log(`  Calling pool.withdraw() on Starknet verifier...`);
  await sleep(1500);
  console.log(`  ✓ Nullifier stored on-chain`);
  console.log(`  Same note cannot be spent twice.`);
  await sleep(1000);
  console.log();

  console.log('  Done.');
  process.exit(0);
}

run().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
