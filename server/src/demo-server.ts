/**
 * Demo API server with Wraith x402 paywall
 *
 * Simulates a paid AI API endpoint (like Perplexity) that accepts
 * Wraith private payments instead of traditional credit card billing.
 *
 * Run:
 *   cd server && npm run dev
 *   # Then run the langchain-agent example to test
 */

import express, { type Request, type Response } from 'express';
import { Account, RpcProvider } from 'starknet';
import { wraithPaywall } from './middleware.js';
import { WithdrawalQueue } from './withdrawal-queue.js';

const app = express();
app.use(express.json());

const STARKNET_RPC    = process.env.STARKNET_RPC_URL        ?? 'http://127.0.0.1:5050';
const API_ADDRESS     = process.env.API_STARKNET_ADDRESS    ?? '';
const API_PK          = process.env.API_STARKNET_PRIVATE_KEY ?? '';
const POOL_ADDRESS    = process.env.POOL_ADDRESS             ?? '';
const CIRCUIT_WASM    = process.env.CIRCUIT_WASM_PATH        ?? '../circuits/pool_js/pool.wasm';
const CIRCUIT_ZKEY    = process.env.CIRCUIT_ZKEY_PATH        ?? '../circuits/target/pool_final.zkey';

if (!API_ADDRESS || !API_PK || !POOL_ADDRESS) {
  console.error(
    'Missing required env vars: API_STARKNET_ADDRESS, API_STARKNET_PRIVATE_KEY, POOL_ADDRESS'
  );
  process.exit(1);
}

const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });
const account  = new Account(provider, API_ADDRESS, API_PK);

// Withdrawal queue — processes accumulated payments every 5 minutes
const withdrawalQueue = new WithdrawalQueue({
  account,
  poolAddress:      POOL_ADDRESS,
  circuitWasmPath:  CIRCUIT_WASM,
  circuitZkeyPath:  CIRCUIT_ZKEY,
  rpcUrl:           STARKNET_RPC,
});
withdrawalQueue.start();

// -------------------------------------------------------------------------
// Paid endpoint: POST /v1/chat/completions
// Simulates an OpenAI-compatible LLM API with 0.003 USDC per request
// -------------------------------------------------------------------------
app.post(
  '/v1/chat/completions',
  wraithPaywall({
    amount: 3000n,     // 0.003 USDC
    token: 'USDC',
    starknetRpcUrl: STARKNET_RPC,
    withdrawalAddress: API_ADDRESS,
    onVerified: (proof) => {
      withdrawalQueue.enqueue(proof, 3000n);
    },
  }),
  (req: Request, res: Response) => {
    // In a real implementation, forward to the underlying LLM here
    const messages = (req.body.messages ?? []) as Array<{ role: string; content: string }>;
    const lastMessage = messages[messages.length - 1]?.content ?? '';

    // Demo response
    res.json({
      id: `wraith-demo-${Date.now()}`,
      object: 'chat.completion',
      model: 'wraith-demo-v1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `[Demo response to: "${lastMessage.slice(0, 50)}..."] ` +
              `Payment verified. This response would come from the underlying LLM.`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  }
);

// -------------------------------------------------------------------------
// Health check
// -------------------------------------------------------------------------
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    withdrawalQueueLength: withdrawalQueue.queueLength(),
    proverIntegrated: false, // honest: prover is not wired up yet
  });
});

// -------------------------------------------------------------------------
// Start
// -------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '3000');
app.listen(PORT, () => {
  console.log(`Wraith demo server running on port ${PORT}`);
  console.log(`POST /v1/chat/completions — requires 0.003 USDC Wraith payment`);
  console.log(`GET  /health — server status`);
  console.log(`\nHonest status: prover not integrated. Deposits accepted, withdrawals queued but not executed.`);
});

export { app };
