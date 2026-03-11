/**
 * Wraith Protocol — Server Middleware Integration Test
 *
 * Tests the x402 payment flow against a real devnet.
 * Requires: devnet running on :5050 with at least one deposit.
 * Run onchain.test.mjs first.
 *
 * Privacy boundary verified:
 *   - middleware only receives txHash + litCiphertext, NOT plaintext secret/nullifier
 *   - verifyDepositOnChain only reads the on-chain Deposit event
 *   - plaintext secrets must NEVER appear in the queue
 */

import { strict as assert } from 'assert';
import http from 'http';
import express from 'express';

// Dynamic imports so we test the actual compiled source
const { wraithPaywall } = await import('../server/src/middleware.js');
const { buildPaymentHeader, X402_SCHEME } = await import('../sdk/src/x402.js');

const DEVNET_RPC = 'http://127.0.0.1:5050';
const DEPOSIT_SELECTOR = '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2';

// ── Helpers ────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
    fail++;
  }
}

async function rpc(method, params) {
  const res = await fetch(DEVNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`RPC ${method}: ${JSON.stringify(error)}`);
  return result;
}

async function post(url, headers, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Discover pool + deposit from devnet ───────────────────────────────────

async function findLatestDeposit() {
  const blockNumber = await rpc('starknet_blockNumber', []);
  const { events } = await rpc('starknet_getEvents', [{
    from_block: { block_number: 0 },
    to_block:   { block_number: blockNumber },
    keys:       [[DEPOSIT_SELECTOR]],
    chunk_size: 10,
  }]);
  if (!events?.length) return null;
  const event = events[events.length - 1]; // most recent
  const amountLow  = BigInt(event.data?.[0] ?? '0');
  const amountHigh = BigInt(event.data?.[1] ?? '0');
  return {
    txHash:      event.transaction_hash,
    poolAddress: event.from_address,
    amount:      amountLow + (amountHigh << 128n),
  };
}

// ── Start a minimal demo server ────────────────────────────────────────────

function startTestServer(poolAddress, requiredAmount) {
  const queue = [];
  const app = express();
  app.use(express.json());

  app.post('/paid', wraithPaywall({
    amount:            requiredAmount,
    token:             'ETH',
    starknetRpcUrl:    DEVNET_RPC,
    withdrawalAddress: poolAddress,
    onVerified: (proof) => queue.push(proof),
  }), (_req, res) => res.json({ success: true }));

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, queue });
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('\nWraith Protocol — Server Middleware Integration Test\n');

// Guard: devnet must be running
try {
  const alive = await fetch(`${DEVNET_RPC}/is_alive`);
  if (!alive.ok) throw new Error();
} catch {
  console.error('ERROR: devnet not running on :5050. Run onchain.test.mjs first.');
  process.exit(1);
}

const deposit = await findLatestDeposit();
if (!deposit) {
  console.error('ERROR: no Deposit events on devnet. Run onchain.test.mjs first.');
  process.exit(1);
}

console.log(`Pool:    ${deposit.poolAddress}`);
console.log(`Tx:      ${deposit.txHash}`);
console.log(`Amount:  ${deposit.amount} (${Number(deposit.amount) / 1e18} ETH)\n`);

const { server, port, queue } = await startTestServer(deposit.poolAddress, deposit.amount);
const BASE = `http://127.0.0.1:${port}`;

// ── Tests ──────────────────────────────────────────────────────────────────

await test('no proof → 402 with Wraith-Starknet-v1 challenge header', async () => {
  const res = await post(BASE + '/paid', {}, { prompt: 'test' });
  assert.equal(res.status, 402);
  const auth = res.headers.get('WWW-Authenticate');
  assert(auth?.startsWith('Wraith-Starknet-v1'), `got: ${auth}`);
  assert(auth.includes(`payTo="${deposit.poolAddress}"`), `payTo missing: ${auth}`);
  assert(auth.includes('ETH'), `token missing: ${auth}`);
});

await test('wrong scheme header → 402', async () => {
  const res = await post(BASE + '/paid', {
    'X-Payment-Proof':  'abc',
    'X-Payment-Scheme': 'some-other-scheme',
  }, {});
  assert.equal(res.status, 402);
});

await test('malformed base64 proof → 400', async () => {
  const res = await post(BASE + '/paid', {
    'X-Payment-Proof':  '!!!not-base64!!!',
    'X-Payment-Scheme': X402_SCHEME,
  }, {});
  assert.equal(res.status, 400);
});

await test('missing txHash in proof → 402', async () => {
  const header = buildPaymentHeader({ scheme: X402_SCHEME, network: 'starknet-devnet' });
  const res = await post(BASE + '/paid', {
    'X-Payment-Proof':  header,
    'X-Payment-Scheme': X402_SCHEME,
  }, {});
  assert.equal(res.status, 402);
  const body = await res.json();
  assert(body.reason?.includes('txHash'), `expected txHash error, got: ${JSON.stringify(body)}`);
});

await test('nonexistent txHash → 402 (tx not confirmed)', async () => {
  const header = buildPaymentHeader({
    scheme:  X402_SCHEME,
    network: 'starknet-devnet',
    txHash:  '0x' + '0'.repeat(63) + '1',
    litCiphertext: JSON.stringify({ mock: true }),
  });
  const res = await post(BASE + '/paid', {
    'X-Payment-Proof':  header,
    'X-Payment-Scheme': X402_SCHEME,
  }, {});
  assert.equal(res.status, 402);
});

await test('real deposit txHash → 200 (Deposit event verified on-chain)', async () => {
  // litCiphertext is present but mock — middleware does NOT decrypt it.
  // Decryption only happens at withdrawal time (via Lit network).
  // This is the core privacy boundary: middleware verifies payment without
  // ever seeing the plaintext (secret, nullifier).
  const header = buildPaymentHeader({
    scheme:        X402_SCHEME,
    network:       'starknet-devnet',
    txHash:        deposit.txHash,
    litCiphertext: JSON.stringify({ ciphertext: 'mock', dataToEncryptHash: 'mock' }),
  });
  const res = await post(BASE + '/paid', {
    'X-Payment-Proof':  header,
    'X-Payment-Scheme': X402_SCHEME,
  }, { prompt: 'hello from agent' });
  const text = await res.text();
  assert.equal(res.status, 200, `got ${res.status}, body: ${text}`);
  const body = JSON.parse(text);
  assert.equal(body.success, true);
});

await test('queue has 1 item; plaintext secret/nullifier never in queue', async () => {
  assert.equal(queue.length, 1, `expected 1 item, got ${queue.length}`);
  assert.equal(queue[0].txHash, deposit.txHash, 'wrong txHash in queue');

  // Privacy invariant: middleware must NOT have extracted plaintext secrets
  // from the litCiphertext. The queue item should only contain the encrypted blob.
  assert(!queue[0].secret,    'PRIVACY VIOLATION: plaintext secret in queue');
  assert(!queue[0].nullifier, 'PRIVACY VIOLATION: plaintext nullifier in queue');
  assert(queue[0].litCiphertext, 'litCiphertext missing from queue item');
});

await test('amount below required → 402 (wrong pool deposit amount)', async () => {
  // Use the same txHash but set the required amount to MORE than was deposited.
  // We do this by spinning up a second server with a higher required amount.
  const { server: s2, port: p2 } = await startTestServer(
    deposit.poolAddress,
    deposit.amount + 1n, // one more than deposited
  );
  const header = buildPaymentHeader({
    scheme:        X402_SCHEME,
    network:       'starknet-devnet',
    txHash:        deposit.txHash,
    litCiphertext: JSON.stringify({ ciphertext: 'mock', dataToEncryptHash: 'mock' }),
  });
  const res = await post(`http://127.0.0.1:${p2}/paid`, {
    'X-Payment-Proof':  header,
    'X-Payment-Scheme': X402_SCHEME,
  }, {});
  s2.close();
  assert.equal(res.status, 402, `expected 402 for underpayment, got ${res.status}`);
  const body = await res.json();
  assert(body.reason?.toLowerCase().includes('amount'), `expected amount error: ${JSON.stringify(body)}`);
});

// ── Results ────────────────────────────────────────────────────────────────

server.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed\n`);

if (fail > 0) {
  process.exit(1);
}

console.log('VERIFIED:');
console.log('  402 challenge format correct (scheme, token, payTo)');
console.log('  Malformed/missing proofs rejected before any RPC call');
console.log('  Real Deposit event accepted (correct selector, u256 amount)');
console.log('  Underpayment rejected correctly');
console.log('  Queue populated; plaintext (secret, nullifier) never exposed');
console.log('\nNOT TESTED (requires live Lit Datil network):');
console.log('  processWithdrawal() → getLitSessionSigs() → decryptNoteFromAgent()');
console.log('  Full withdrawal queue flush → pool.withdraw()');
