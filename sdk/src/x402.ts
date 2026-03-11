/**
 * x402 Middleware for Wraith Protocol
 *
 * Handles the HTTP 402 Payment Required flow with ZK-private payments.
 *
 * Standard x402 flow:
 * 1. Client hits API endpoint
 * 2. Server returns 402 with payment challenge in header
 * 3. Client pays and retries with proof in header
 * 4. Server verifies proof and responds
 *
 * Wraith extension:
 * - Payment = deposit into privacy pool
 * - Proof = Deposit event + Lit-encrypted (secret, nullifier) bundle
 * - API verifies Deposit event (instant) then grants access
 * - API withdraws from pool on its own schedule (no latency pressure)
 *
 * HONEST CAVEAT (v1):
 * - Depositor's Starknet address is visible to anyone monitoring the chain
 * - Only the link deposit→API is private
 * - Do NOT use v1 if agent identity must be fully hidden
 */

import { X402Challenge, X402PaymentProof, PaymentIntent } from './types.js';

export const X402_SCHEME = 'wraith-starknet-v1';

/**
 * Parse a 402 response and extract the payment challenge.
 * Challenge is in the WWW-Authenticate header.
 *
 * Format: Wraith-Starknet-v1 network="starknet-mainnet",token="USDC",amount="1000",payTo="0x..."
 */
export function parseChallenge(response: Response): X402Challenge | null {
  if (response.status !== 402) return null;

  const auth = response.headers.get('WWW-Authenticate');
  if (!auth?.startsWith('Wraith-Starknet')) return null;

  const params: Record<string, string> = {};
  for (const match of auth.matchAll(/(\w+)="([^"]+)"/g)) {
    params[match[1]] = match[2];
  }

  return {
    scheme: X402_SCHEME,
    network: params.network ?? 'starknet-mainnet',
    token: params.token ?? 'USDC',
    amount: params.amount ?? '0',
    payTo: params.payTo ?? '',
    memo: params.memo,
  };
}

/**
 * Build a payment intent from a parsed x402 challenge.
 */
export function challengeToIntent(
  challenge: X402Challenge,
  maxLatencyMs?: number
): PaymentIntent {
  return {
    url: challenge.payTo,
    amount: BigInt(challenge.amount),
    token: challenge.token,
    maxLatencyMs,
  };
}

/**
 * Build the X-Payment-Proof header value from a deposit tx + Lit ciphertext.
 *
 * The API receives:
 * - txHash + depositEvent: to verify the deposit exists on-chain
 * - litCiphertext: to decrypt (secret, nullifier) and generate withdrawal proof
 *
 * The API does NOT need to withdraw immediately. It can batch withdrawals
 * and use the secret/nullifier to prove knowledge of the deposit at any time.
 */
export function buildPaymentHeader(proof: X402PaymentProof): string {
  return Buffer.from(JSON.stringify(proof)).toString('base64');
}

/**
 * Parse the X-Payment-Proof header from a request.
 */
export function parsePaymentHeader(header: string): X402PaymentProof {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

/**
 * Verify a payment proof on the server side.
 *
 * Checks:
 * 1. Deposit event exists on-chain (tx hash + event data)
 * 2. Amount matches the challenge
 * 3. Token matches the challenge
 *
 * Does NOT verify the ZK proof — that's deferred to withdrawal time.
 * This keeps the request path fast (just an RPC call, no proof verification).
 */
export async function verifyDepositOnChain(
  proof: X402PaymentProof,
  expectedAmount: bigint,
  expectedToken: string,
  starknetRpcUrl: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!proof.txHash) {
    return { valid: false, reason: 'Missing txHash' };
  }

  // Call starknet_getTransactionReceipt via JSON-RPC
  const body = {
    jsonrpc: '2.0',
    method: 'starknet_getTransactionReceipt',
    params: [proof.txHash],
    id: 1,
  };

  let receipt: StarknetReceipt;
  try {
    const res = await fetch(starknetRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { result: StarknetReceipt };
    receipt = data.result;
  } catch (err) {
    return { valid: false, reason: `RPC error: ${err}` };
  }

  if (!receipt || receipt.execution_status !== 'SUCCEEDED') {
    return { valid: false, reason: 'Transaction not confirmed or failed' };
  }

  // Find Deposit event emitted by any pool contract in this tx.
  //
  // Actual on-chain layout (verified from devnet receipt):
  //   keys[0] = sn_keccak("Deposit") = 0x9149d2...
  //   keys[1] = caller (ContractAddress, #[key])
  //   keys[2] = secret_and_nullifier_hash low (u256 low word, #[key])
  //   keys[3] = secret_and_nullifier_hash high (u256 high word, #[key])
  //   data[0] = amount low  (u256 low word)
  //   data[1] = amount high (u256 high word)
  const DEPOSIT_SELECTOR = '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2';

  const depositEvent = receipt.events?.find(
    (e) => e.keys?.[0] === DEPOSIT_SELECTOR
  );

  if (!depositEvent) {
    return { valid: false, reason: 'No Deposit event found in transaction' };
  }

  // Amount is a u256 split across data[0] (low) and data[1] (high)
  const amountLow  = BigInt(depositEvent.data?.[0] ?? '0');
  const amountHigh = BigInt(depositEvent.data?.[1] ?? '0');
  const depositedAmount = amountLow + (amountHigh << 128n);

  if (depositedAmount < expectedAmount) {
    return {
      valid: false,
      reason: `Deposit amount ${depositedAmount} < required ${expectedAmount}`,
    };
  }

  return { valid: true };
}

interface StarknetReceipt {
  execution_status: string;
  events?: Array<{
    keys: string[];
    data: string[];
  }>;
}
