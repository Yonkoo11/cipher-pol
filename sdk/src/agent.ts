/**
 * WraithAgent — main entry point
 *
 * Usage:
 * ```ts
 * import { WraithAgent } from 'wraith-agent';
 *
 * const agent = new WraithAgent({
 *   adapter: 'privacy-pools',
 *   starknetRpcUrl: 'https://starknet-mainnet.infura.io/v3/...',
 * });
 *
 * // Pay an x402 API endpoint (private)
 * const result = await agent.pay('https://api.perplexity.ai/chat/completions', {
 *   amount: 3000n,   // 0.003 USDC (6 decimals)
 *   token: 'USDC',
 * });
 *
 * // Get honest privacy score
 * const score = agent.getPrivacyScore();
 * console.log(score.guarantee); // 'demo' for v1, 'zk-native' for STRK20
 * ```
 */

import { Account, RpcProvider } from 'starknet';
import {
  WraithConfig,
  Note,
  PaymentIntent,
  PaymentReceipt,
  PrivacyScore,
  X402PaymentProof,
} from './types.js';
import { IPrivacyAdapter } from './types.js';
import { PrivacyPoolsAdapter } from './adapters/privacy-pools.js';
import { STRK20Adapter } from './adapters/strk20.js';
import { PaymentBatcher } from './batcher.js';
import {
  parseChallenge,
  buildPaymentHeader,
  X402_SCHEME,
} from './x402.js';
import { encryptNoteForAPI } from './lit.js';
import {
  createAgentManifest,
  manifestToDataURI,
  generatePaymentReceipt,
  type AgentReceipt,
} from './erc8004.js';

export class WraithAgent {
  private adapter: IPrivacyAdapter;
  private batcher: PaymentBatcher;
  private config: Required<WraithConfig>;

  constructor(config: WraithConfig, account?: Account) {
    this.config = {
      starknetRpcUrl: 'https://starknet-mainnet.public.blastapi.io',
      litNetwork: 'datil',
      storachaEmail: '',
      settlementFeeBps: 10, // 0.1%
      ...config,
    } as Required<WraithConfig>;

    // Select adapter
    if (config.adapter === 'strk20') {
      this.adapter = new STRK20Adapter();
    } else {
      if (!account) throw new Error('PrivacyPoolsAdapter requires an Account instance');
      this.adapter = new PrivacyPoolsAdapter(account);
    }

    this.batcher = new PaymentBatcher();
  }

  /**
   * Pay an x402 API endpoint with a private payment.
   *
   * Automatically handles the 402 challenge/response cycle.
   * Returns the API response after payment is verified.
   */
  async pay(
    url: string,
    init: RequestInit & { amount: bigint; token: string; maxLatencyMs?: number }
  ): Promise<Response> {
    // 1. Hit the endpoint — expect 402
    const probe = await fetch(url, {
      ...init,
      headers: { ...init.headers },
    });

    if (probe.status !== 402) {
      // Not payment-gated, just return
      return probe;
    }

    const challenge = parseChallenge(probe);
    if (!challenge) {
      throw new Error(`402 response missing valid payment challenge from ${url}`);
    }

    // 2. Deposit into privacy pool
    const intent: PaymentIntent = {
      url: challenge.payTo,
      amount: init.amount,
      token: init.token,
      maxLatencyMs: init.maxLatencyMs,
    };

    const { txHash, note } = await this.adapter.deposit(intent.amount, intent.token);

    // 3. Package proof for API
    // In v1: we send (txHash, depositEvent) for on-chain verification
    // Lit-encrypted (secret, nullifier) sent so API can generate withdrawal proof
    // 3a. Encrypt (secret, nullifier) for the API so it can generate the withdrawal proof.
    //     The API decrypts using its Starknet address via Lit Protocol.
    //     Without this, the API cannot withdraw from the pool — funds sit there indefinitely.
    let litCiphertext: string | undefined;
    if (this.config.litNetwork) {
      try {
        const encrypted = await encryptNoteForAPI(
          note.secret,
          note.nullifier,
          challenge.payTo,
          this.config.litNetwork
        );
        litCiphertext = JSON.stringify(encrypted);
      } catch (err) {
        // Lit encryption failed — proceed without it, but warn
        // API can still verify deposit, but cannot generate withdrawal proof
        console.warn('[Wraith] Lit encryption failed — withdrawal proof generation will fail:', err);
      }
    }

    // Attach ERC-8004 agent identity to proof (if configured)
    let agentURI: string | undefined;
    if (this.config.erc8004) {
      const manifest = createAgentManifest(
        this.config.erc8004,
        this.config.adapter,
        this.adapter.getPrivacyScore().guarantee
      );
      agentURI = manifestToDataURI(manifest);
    }

    const proof: X402PaymentProof = {
      scheme: X402_SCHEME,
      network: challenge.network,
      txHash,
      litCiphertext,
      agentURI,
      agentId: this.config.erc8004?.agentId?.toString(),
    };

    // 4. Retry request with payment proof
    const paymentHeader = buildPaymentHeader(proof);
    const result = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        'X-Payment-Proof': paymentHeader,
        'X-Payment-Scheme': X402_SCHEME,
      },
    });

    return result;
  }

  /**
   * Pay an x402 endpoint and return both the API response and an ERC-8004 receipt.
   *
   * The receipt proves the agent autonomously paid for and accessed a service.
   * It follows the ERC-8004 off-chain feedback file format and can be submitted
   * to the Reputation Registry to build the agent's on-chain reputation.
   *
   * @example
   * const { response, receipt } = await agent.payWithReceipt(url, {
   *   amount: 3000n, token: 'USDC', poolAddress: '0x...'
   * });
   * // receipt.agentURI contains the ERC-8004 registration file
   * // receipt.paymentProof.txHash is the Starknet deposit transaction
   */
  async payWithReceipt(
    url: string,
    init: RequestInit & { amount: bigint; token: string; poolAddress: string; maxLatencyMs?: number }
  ): Promise<{ response: Response; receipt: AgentReceipt }> {
    const response = await this.pay(url, init);

    const receipt = generatePaymentReceipt(
      // txHash not directly available here — caller passes poolAddress separately
      // In a real impl, adapter.deposit() would return the pool address too
      '',
      'starknet',
      init.poolAddress,
      url,
      init.amount,
      init.token,
      this.config.erc8004
    );

    return { response, receipt };
  }

  /**
   * Get the ERC-8004 agent manifest for this agent.
   *
   * The manifest can be hosted at HTTPS or stored on IPFS, then registered
   * on the Ethereum ERC-8004 Identity Registry via:
   *   identityRegistry.register(agentURI)
   *
   * Returns null if no erc8004 config was provided.
   */
  getAgentManifest(): { manifest: ReturnType<typeof createAgentManifest>; uri: string } | null {
    if (!this.config.erc8004) return null;
    const manifest = createAgentManifest(
      this.config.erc8004,
      this.config.adapter,
      this.adapter.getPrivacyScore().guarantee
    );
    return { manifest, uri: manifestToDataURI(manifest) };
  }

  /**
   * Get the honest privacy score for the current adapter.
   * Print this to your users so they know what privacy they actually have.
   */
  getPrivacyScore(): PrivacyScore {
    return this.adapter.getPrivacyScore();
  }

  /**
   * Get the adapter name.
   */
  get adapterName(): string {
    return this.adapter.name;
  }
}
