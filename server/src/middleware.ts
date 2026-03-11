/**
 * Wraith x402 Server Middleware
 *
 * Drop-in Express middleware for APIs that want to accept private Wraith payments.
 *
 * Usage:
 * ```ts
 * import express from 'express';
 * import { wraithPaywall } from 'wraith-agent/server';
 *
 * const app = express();
 *
 * app.post('/api/completion', wraithPaywall({
 *   amount: 3000n,    // 0.003 USDC (6 decimals)
 *   token: 'USDC',
 *   starknetRpcUrl: 'https://starknet-mainnet.infura.io/v3/...',
 *   withdrawalAddress: process.env.API_STARKNET_ADDRESS,
 * }), yourHandler);
 * ```
 *
 * What this does:
 * 1. Checks for X-Payment-Proof header
 * 2. If missing: returns 402 with payment challenge
 * 3. If present: verifies the Deposit event on-chain (fast RPC call, no ZK verification)
 * 4. If valid: calls next() and queues the withdrawal for later
 *
 * Withdrawal batching:
 * - API accumulates (secret, nullifier) pairs from Lit-decrypted proofs
 * - Calls pool.withdraw() in batches off the critical path
 * - This keeps request latency low (no ZK proof verification on hot path)
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyDepositOnChain, parsePaymentHeader, X402_SCHEME } from '../../sdk/src/x402.js';
import type { X402PaymentProof } from '../../sdk/src/types.js';

export interface PaywallConfig {
  amount: bigint;
  token: string;
  starknetRpcUrl: string;
  withdrawalAddress: string;
  network?: string;
  onVerified?: (proof: X402PaymentProof, req: Request) => void;
}

/**
 * Express middleware: require a valid Wraith payment proof on every request.
 */
export function wraithPaywall(config: PaywallConfig) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const proofHeader = req.headers['x-payment-proof'] as string | undefined;
    const schemeHeader = req.headers['x-payment-scheme'] as string | undefined;

    // No payment proof — issue a 402 challenge
    if (!proofHeader || schemeHeader !== X402_SCHEME) {
      return res
        .status(402)
        .setHeader(
          'WWW-Authenticate',
          buildChallenge(config)
        )
        .json({
          error: 'Payment Required',
          scheme: X402_SCHEME,
          amount: config.amount.toString(),
          token: config.token,
          network: config.network ?? 'starknet-mainnet',
          payTo: config.withdrawalAddress,
        });
    }

    // Parse and verify the proof
    let proof: X402PaymentProof;
    try {
      proof = parsePaymentHeader(proofHeader);
    } catch {
      return res.status(400).json({ error: 'Malformed payment proof' });
    }

    const { valid, reason } = await verifyDepositOnChain(
      proof,
      config.amount,
      config.token,
      config.starknetRpcUrl
    );

    if (!valid) {
      return res.status(402).json({
        error: 'Payment verification failed',
        reason,
      });
    }

    // Notify caller so they can queue the withdrawal
    config.onVerified?.(proof, req);

    // Attach payment info to request for downstream handlers
    (req as WraithRequest).wraith = {
      paid: true,
      amount: config.amount,
      token: config.token,
      txHash: proof.txHash ?? '',
      agentId: proof.agentId,
      agentURI: proof.agentURI,
    };

    next();
  };
}

/**
 * Build the WWW-Authenticate challenge header value.
 */
function buildChallenge(config: PaywallConfig): string {
  return [
    `Wraith-Starknet-v1`,
    `network="${config.network ?? 'starknet-mainnet'}"`,
    `token="${config.token}"`,
    `amount="${config.amount}"`,
    `payTo="${config.withdrawalAddress}"`,
  ].join(' ');
}

export interface WraithRequest extends Request {
  wraith?: {
    paid: boolean;
    amount: bigint;
    token: string;
    txHash: string;
    /** ERC-8004 agent ID (ERC-721 token on Identity Registry, if registered) */
    agentId?: string;
    /** ERC-8004 agent registration file URI (data: or IPFS) */
    agentURI?: string;
  };
}
