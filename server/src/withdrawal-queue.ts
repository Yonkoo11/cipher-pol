/**
 * WithdrawalQueue — API server-side withdrawal batching + proof generation
 *
 * Flow:
 * 1. Agent deposits → sends Lit-encrypted (secret, nullifier) in X-Payment-Proof header
 * 2. API verifies Deposit event (instant, in middleware)
 * 3. API queues (secret, nullifier) for batch withdrawal
 * 4. Every 5 minutes: decrypt → get Merkle root → generate Groth16 proof → withdraw
 *
 * Prover performance:
 * - snarkjs WASM: ~2-5s per proof (fine for batch processing)
 * - RapidSnark binary: ~100ms per proof (recommended for >100 req/day)
 *
 * TRUSTED SETUP REQUIREMENT:
 * Run `npm run setup` in circuits/ once to generate:
 *   target/pool.wasm    (compiled circuit)
 *   target/pool_final.zkey   (proving key)
 * Set CIRCUIT_WASM_PATH and CIRCUIT_ZKEY_PATH environment variables.
 */

import path from 'path';
import { Account, RpcProvider, CallData, uint256 } from 'starknet';
import type { X402PaymentProof } from '../../sdk/src/types.js';
import { decryptNoteFromAgent } from '../../sdk/src/lit.js';
import {
  generateWithdrawProof,
  buildSingleDepositMerkleProof,
  type WithdrawWitness,
} from '../../sdk/src/prover.js';

interface QueuedWithdrawal {
  proof: X402PaymentProof;
  amount: bigint;
  recipient: string;
  queuedAt: number;
  attempts: number;
}

interface WithdrawalQueueConfig {
  /** Starknet account that will call pool.withdraw() */
  account: Account;
  /** Deployed Ekubo Privacy Pool contract address */
  poolAddress: string;
  /** Path to pool.wasm from circuit compilation */
  circuitWasmPath: string;
  /** Path to pool_final.zkey from trusted setup */
  circuitZkeyPath: string;
  /** Starknet RPC URL */
  rpcUrl: string;
  /** Flush interval in ms (default: 5 minutes) */
  flushIntervalMs?: number;
}

export class WithdrawalQueue {
  private queue: QueuedWithdrawal[] = [];
  private config: Required<WithdrawalQueueConfig>;
  private timer?: ReturnType<typeof setInterval>;
  private provider: RpcProvider;

  constructor(config: WithdrawalQueueConfig) {
    this.config = { flushIntervalMs: 5 * 60 * 1000, ...config };
    this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    console.log(`[WithdrawalQueue] Started. Flushing every ${this.config.flushIntervalMs / 1000}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(proof: X402PaymentProof, amount: bigint): void {
    this.queue.push({
      proof,
      amount,
      recipient: this.config.account.address,
      queuedAt: Date.now(),
      attempts: 0,
    });
  }

  queueLength(): number {
    return this.queue.length;
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    console.log(`[WithdrawalQueue] Flushing ${batch.length} withdrawals...`);

    for (const item of batch) {
      try {
        await this.processWithdrawal(item);
      } catch (err) {
        item.attempts += 1;
        if (item.attempts < 3) {
          this.queue.push(item);
          console.error(`[WithdrawalQueue] Withdrawal failed (attempt ${item.attempts}), re-queued:`, err);
        } else {
          console.error(`[WithdrawalQueue] DROPPED after 3 attempts:`, item.proof.txHash, err);
        }
      }
    }
  }

  private async processWithdrawal(item: QueuedWithdrawal): Promise<void> {
    // Step 1: Decrypt (secret, nullifier) from Lit-encrypted bundle
    if (!item.proof.litCiphertext) {
      throw new Error(
        `No litCiphertext in proof (txHash=${item.proof.txHash}). ` +
        `Agent must send Lit-encrypted note for withdrawal to work.`
      );
    }

    const encrypted = JSON.parse(item.proof.litCiphertext);

    // For server-side decryption, we need session signatures.
    // In production: call litNodeClient.getSessionSigs() with the server's auth sig.
    // For now, we throw with a clear message rather than silently failing.
    // TODO: implement server-side Lit session sig generation.
    const sessionSigs = await this.getLitSessionSigs();

    const { secret, nullifier } = await decryptNoteFromAgent(encrypted, sessionSigs);

    // Step 2: Get current Merkle root from pool contract
    const poolRoot = await this.getPoolRoot();

    // Step 3: Build Merkle proof for our deposit
    // For a real implementation with a full pool, you need to track the Merkle tree
    // and find the leaf index of this specific deposit.
    // For the demo (single deposit in pool), use the simplified single-deposit proof.
    const leafHash = await this.computeLeafHash(secret, nullifier, item.amount);
    const { pathElements, pathIndices, root: computedRoot } = buildSingleDepositMerkleProof(leafHash);

    // Validate that our computed root matches what's on-chain
    if (computedRoot !== poolRoot) {
      throw new Error(
        `Merkle root mismatch: computed=${computedRoot}, on-chain=${poolRoot}. ` +
        `Pool likely has multiple deposits — full Merkle tree tracking required.`
      );
    }

    // Step 4: Build witness for proof generation
    const witness: WithdrawWitness = {
      secret,
      nullifier,
      amount: item.amount,
      recipient: item.recipient,
      fee: 0n,             // no relayer fee
      refund: 0n,          // no refund (full withdrawal)
      commitmentAmount: item.amount,
      pathElements,
      pathIndices,
      root: poolRoot,
      // For simple withdrawals without compliance proof, use same root
      associatedSetRoot: poolRoot,
      associatedSetPathElements: pathElements,
      associatedSetPathIndices: pathIndices,
    };

    // Step 5: Generate Groth16 proof (~2-5s)
    console.log(`[WithdrawalQueue] Generating proof for txHash=${item.proof.txHash}...`);
    const { proofFelts } = await generateWithdrawProof(witness, {
      wasmPath: this.config.circuitWasmPath,
      zkeyPath: this.config.circuitZkeyPath,
    });

    // Step 6: Submit withdrawal to Starknet
    // fn withdraw(proof: Span<felt252>) -> bool
    const { transaction_hash } = await this.config.account.execute({
      contractAddress: this.config.poolAddress,
      entrypoint: 'withdraw',
      calldata: CallData.compile({
        proof: proofFelts.map(String),
      }),
    });

    console.log(
      `[WithdrawalQueue] Withdrawal submitted:`,
      `txHash=${transaction_hash}`,
      `amount=${item.amount}`,
      `recipient=${item.recipient}`
    );
  }

  private async getPoolRoot(): Promise<bigint> {
    // Call pool.current_root() via starknet_call
    const result = await this.provider.callContract({
      contractAddress: this.config.poolAddress,
      entrypoint: 'current_root',
      calldata: [],
    });

    // current_root() returns u256 → two felt252 values (low, high)
    const low = BigInt(result[0]);
    const high = BigInt(result[1] ?? '0');
    return low + (high << 128n);
  }

  private async computeLeafHash(secret: bigint, nullifier: bigint, amount: bigint): Promise<bigint> {
    // Leaf = CommitmentHasher(secret, nullifier, amount) from pool.circom:
    //   temp       = poseidon2([secret, nullifier])
    //   commitment = poseidon2([temp, amount])
    const { computeCommitment } = await import('../../sdk/src/crypto/poseidon.js');
    return computeCommitment(secret, nullifier, amount);
  }

  /**
   * Generate Lit session signatures for the API server.
   *
   * Requires SERVER_ETH_PRIVATE_KEY env var — a standard Ethereum private key (0x...).
   * This key's address must match the access condition set during encryption
   * (ethAddressFromStarknet(this.config.account.address)).
   *
   * Session sigs are valid for 24h. Production: cache and refresh automatically.
   *
   * NOT tested against real Lit network — requires live network connection.
   * The types are messy across Lit v7 packages, hence the any casts.
   */
  private async getLitSessionSigs(): Promise<Record<string, unknown>> {
    const privateKey = process.env.SERVER_ETH_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        'SERVER_ETH_PRIVATE_KEY env var not set. ' +
        'Set it to an Ethereum private key whose address matches the Lit access condition.'
      );
    }

    // Dynamic imports — Lit SDK is large and optional
    const { LitNodeClient } = await import('@lit-protocol/lit-node-client');
    const { ethers } = await import('ethers');
    const { createSiweMessage, generateAuthSig, LitActionResource } =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await import('@lit-protocol/auth-helpers') as any;
    // LitAbility lives in @lit-protocol/constants, not auth-helpers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { LitAbility } = await import('@lit-protocol/constants') as any;

    const client = new LitNodeClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      litNetwork: 'datil' as any,
      debug: false,
    });
    await client.connect();

    const wallet = new ethers.Wallet(privateKey);
    const address = await wallet.getAddress();

    const latestBlockhash = await client.getLatestBlockhash();

    const sessionSigs = await client.getSessionSigs({
      chain: 'ethereum',
      expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
      resourceAbilityRequests: [
        {
          resource: new LitActionResource('*'),
          ability: LitAbility.AccessControlConditionDecryption,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authNeededCallback: async (params: any) => {
        const toSign = await createSiweMessage({
          uri:            params.uri ?? '',
          expiration:     params.expiration,
          resources:      params.resourceAbilityRequests,
          walletAddress:  address,
          nonce:          latestBlockhash,
          litNodeClient:  client,
        });
        return await generateAuthSig({ signer: wallet, toSign });
      },
    });

    return sessionSigs;
  }
}
