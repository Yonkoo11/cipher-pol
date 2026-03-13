/**
 * PrivacyPoolsAdapter — wraps Ekubo Privacy Pools on Starknet.
 *
 * HONEST PRIVACY GUARANTEES:
 * - Depositor address IS VISIBLE on-chain (Deposit event emits caller)
 * - Link deposit→withdrawal is hidden via Groth16 ZK proof (BN254)
 * - Groth16 is NOT quantum-resistant
 * - Server NEVER sees (secret, nullifier) — ZK proof generated client-side
 * - Server NEVER sees txHash — proof commits to recipient without revealing depositor
 * - Anonymity set = number of deposits in pool since your deposit
 *   (more deposits = better privacy; don't withdraw immediately after depositing)
 *
 * Use this for demos and testing. Upgrade to STRK20Adapter when it ships.
 *
 * See docs/THREAT_MODEL.md for the complete privacy analysis.
 */

import { Account, CallData, RpcProvider, uint256 } from 'starknet';
import { IPrivacyAdapter, Note, PrivacyScore, PaymentReceipt, AuditProof, X402PaymentProof } from '../types.js';
import { poseidonHash, computeCommitment, computeNullifierHash } from '../crypto/poseidon.js';
import {
  IncrementalMerkleTree,
  buildTreeFromCommitments,
  TREE_DEPTH,
} from '../crypto/merkle-tree.js';
import {
  generateWithdrawProof,
  buildSingleDepositMerkleProof,
  type ProverArtifacts,
  type WithdrawWitness,
} from '../prover.js';
import { X402_SCHEME, extractPublicInputs } from '../x402.js';

// Pool address must be configured — no hardcoded address.
// Deploy your own pool instance:
//   cd cairo && scarb build
//   starknet-devnet --seed 0
//   starkli deploy ...
// Or pass the address to the constructor.
const POOL_ADDRESS_PLACEHOLDER = '0x0';

// Deposit event selector: sn_keccak("Deposit")
// Verified from devnet receipts.
const DEPOSIT_SELECTOR = '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2';

export interface DepositEvent {
  commitment: bigint;
  amount: bigint;
  depositorAddress: string;
  blockNumber: number;
  txHash: string;
}

export class PrivacyPoolsAdapter implements IPrivacyAdapter {
  name = 'ekubo-privacy-pools';

  private account: Account;
  private poolAddress: string;
  private provider: RpcProvider;
  private rpcUrl: string;

  constructor(account: Account, poolAddress: string = POOL_ADDRESS_PLACEHOLDER, rpcUrl?: string) {
    this.account = account;
    this.poolAddress = poolAddress;
    this.rpcUrl = rpcUrl ?? 'https://starknet-mainnet.public.blastapi.io';
    this.provider = new RpcProvider({ nodeUrl: this.rpcUrl });
  }

  getPrivacyScore(): PrivacyScore {
    return {
      adapter: this.name,
      depositorVisible: true,       // Deposit event emits caller address
      proofSystem: 'groth16',       // BN254 pairings
      quantumResistant: false,      // Groth16 is NOT QR
      anonymitySetSize: 0,          // Zero until pool has activity
      guarantee: 'demo',
      recommendation:
        'v1 (Groth16): depositor address is on-chain. ' +
        'The deposit→withdrawal link is hidden by ZK proof. ' +
        'Meaningful privacy requires an anonymity set of at least dozens of deposits. ' +
        'Upgrade to STRK20Adapter for quantum-resistant, identity-private payments.',
    };
  }

  /**
   * Deposit into the Ekubo Privacy Pool.
   *
   * Generates a fresh (secret, nullifier) pair, computes the commitment,
   * calls pool.deposit(commitment, amount) on Starknet.
   *
   * The (secret, nullifier) pair is returned in the Note and MUST be stored
   * securely by the agent. It is NEVER sent to any server.
   * Without the Note, you cannot withdraw the deposited funds.
   */
  async deposit(amount: bigint, token: string): Promise<{ txHash: string; note: Note }> {
    const secret = randomFelt();
    const nullifier = randomFelt();

    // pool.deposit() takes H(secret, nullifier) — it computes H(H(s,n), amount) internally
    // as the commitment leaf stored in the Merkle tree.
    const secretAndNullifierHash = poseidonHash(secret, nullifier);
    const commitment = poseidonHash(secretAndNullifierHash, amount); // leaf in pool's Merkle tree

    const { transaction_hash } = await this.account.execute({
      contractAddress: this.poolAddress,
      entrypoint: 'deposit',
      calldata: CallData.compile({
        secret_and_nullifier_hash: uint256.bnToUint256(secretAndNullifierHash),
        amount: uint256.bnToUint256(amount),
      }),
    });

    // We don't know leafIndex until we build the tree after the tx is confirmed.
    // Use -1 as placeholder; call findNoteInTree() after confirmation to get it.
    const note: Note = {
      secret,
      nullifier,
      amount,
      token,
      spent: false,
      commitment,
      leafIndex: -1,
      depositTxHash: transaction_hash,
    };

    return { txHash: transaction_hash, note };
  }

  /**
   * Generate a Groth16 payment proof for making an x402 payment.
   *
   * This is the privacy-critical operation. It generates a ZK proof that:
   * - Proves knowledge of (secret, nullifier) whose commitment is in the Merkle tree
   * - Commits to recipient = API server address (prevents proof reuse with another recipient)
   * - Reveals nullifierHash (for double-spend prevention) and amount
   * - Does NOT reveal: secret, nullifier, leaf index, or depositor address
   *
   * The proof is generated CLIENT-SIDE. The API server receives only the proof
   * and public inputs — it cannot learn which deposit this corresponds to.
   *
   * Requires: circuit artifacts (.wasm + .zkey) from a trusted setup.
   * Run: cd circuits && npm run setup
   * Or use the provided devnet artifacts for testing.
   *
   * @param note           The deposit note (secret, nullifier, amount)
   * @param recipient      The API server's Starknet address (felt252 as 0x string)
   * @param amount         Amount to pay (must be ≤ deposit amount; use note.amount for full payment)
   * @param artifacts      Paths to circuit .wasm and .zkey files
   * @param starknetRpcUrl Override RPC URL for fetching pool state
   */
  async generatePaymentProof(
    note: Note,
    recipient: string,
    amount: bigint,
    artifacts: ProverArtifacts
  ): Promise<X402PaymentProof> {
    if (note.spent) {
      throw new Error('Note is already spent');
    }
    if (amount > note.amount) {
      throw new Error(`Payment amount ${amount} exceeds note amount ${note.amount}`);
    }
    // Partial withdrawals (amount < note.amount) are circuit-correct: the circuit
    // commits refund = note.amount - amount via poseidonHash(nullifier, refund) and
    // posts refundCommitmentHash as a public input. But there is no claimRefund()
    // call path in v1 — the committed refund would be locked on-chain forever.
    // Enforce full withdrawal only until a recovery path is implemented.
    if (amount < note.amount) {
      throw new Error(
        `Partial withdrawals are not supported in v1. ` +
        `Requested ${amount}, note contains ${note.amount}. ` +
        `Pass amount === note.amount to withdraw the full deposit. ` +
        `(The circuit supports partial withdrawals via refundCommitmentHash, ` +
        `but no claimRefund() path exists yet — partial amounts would be locked forever.)`
      );
    }

    // Step 1: Fetch current pool state (Merkle root + all deposits)
    const { root, tree, leafIndex } = await this.buildPoolState(note.commitment);

    if (leafIndex === -1) {
      throw new Error(
        `Commitment not found in pool (${this.poolAddress}). ` +
        `Either the deposit hasn't been confirmed yet, or the pool address is wrong. ` +
        `depositTxHash=${note.depositTxHash}`
      );
    }

    // Step 2: Get Merkle proof for this deposit
    const merkleProof = tree.getProof(leafIndex);

    // Verify our local computation matches on-chain
    if (merkleProof.root !== root) {
      throw new Error(
        `Merkle root mismatch: local=${merkleProof.root}, on-chain=${root}. ` +
        `The pool may have received additional deposits between querying state and building the tree. ` +
        `Retry — this is a race condition.`
      );
    }

    // Step 3: Build witness
    //
    // fee: 0n — no relayer fee in v1. The server submits its own withdrawals.
    //   To add a relayer fee: pass fee > 0 and wire up a relayer that collects
    //   pool.withdraw() fee output. Currently no relayer exists in this codebase.
    //
    // refund: note.amount - amount — non-zero if depositing more than one payment's
    //   worth and withdrawing a partial amount. In practice agents deposit exactly
    //   what they need and refund is 0. The circuit handles partial withdrawals
    //   but this adapter doesn't expose partial amounts in its API surface.
    //
    // associatedSetRoot = main pool root — this means the "association set" is the
    //   entire pool (every depositor is considered compliant). The Privacy Pools
    //   paper's intent is that you prove membership in a *curated* subset of
    //   compliant deposits (e.g., "not sanctioned"). To use real compliance sets,
    //   maintain a separate Merkle tree of approved commitments and pass its root
    //   and your inclusion proof here. Using the main root is valid (all deposits
    //   are in scope) but provides no compliance filtering beyond the main proof.
    const refund = note.amount - amount;
    const witness: WithdrawWitness = {
      secret: note.secret,
      nullifier: note.nullifier,
      amount,
      recipient,
      fee: 0n,
      refund,
      commitmentAmount: note.amount,
      pathElements: merkleProof.pathElements,
      pathIndices: merkleProof.pathIndices,
      root,
      associatedSetRoot: root,
      associatedSetPathElements: merkleProof.pathElements,
      associatedSetPathIndices: merkleProof.pathIndices,
    };

    // Step 4: Generate Groth16 proof (2-5 seconds with snarkjs WASM)
    const { proofFelts, nullifierHash } = await generateWithdrawProof(witness, artifacts);

    const zkProof = proofFelts.map(String);
    const publicInputs = extractPublicInputs(zkProof);

    return {
      scheme: X402_SCHEME,
      network: 'starknet-mainnet',
      zkProof,
      nullifierHash: nullifierHash.toString(),
      publicInputs,
    };
  }

  /**
   * Submit a pre-generated withdrawal proof to the pool contract.
   *
   * This is used by the SERVER to withdraw funds after receiving a payment proof.
   * The server never generates the proof — it only submits what the agent provided.
   */
  async withdraw(
    _note: Note,
    _recipient: string,
    proof: bigint[]
  ): Promise<{ txHash: string }> {
    const { transaction_hash } = await this.account.execute({
      contractAddress: this.poolAddress,
      entrypoint: 'withdraw',
      calldata: CallData.compile({
        proof: proof.map(String),
      }),
    });

    return { txHash: transaction_hash };
  }

  /**
   * Submit a withdrawal proof from the raw felt array (as strings).
   * Used by the server middleware after receiving a payment proof.
   */
  async submitWithdrawal(zkProof: string[]): Promise<{ txHash: string }> {
    const { transaction_hash } = await this.account.execute({
      contractAddress: this.poolAddress,
      entrypoint: 'withdraw',
      calldata: CallData.compile({
        proof: zkProof,
      }),
    });
    return { txHash: transaction_hash };
  }

  /**
   * Build the pool's Merkle tree by fetching all Deposit events from Starknet.
   * Also finds the leaf index for a specific commitment.
   *
   * This rebuilds the full tree client-side by replaying all historical deposits.
   * Call this before generating a payment proof.
   */
  async buildPoolState(
    ourCommitment?: bigint
  ): Promise<{ root: bigint; tree: IncrementalMerkleTree; leafIndex: number; deposits: DepositEvent[] }> {
    const deposits = await this.fetchAllDeposits();
    const commitments = deposits.map((d) => d.commitment);

    const tree = buildTreeFromCommitments(commitments);

    const leafIndex = ourCommitment !== undefined ? tree.findLeaf(ourCommitment) : -1;

    // Cross-check with on-chain root
    const onChainRoot = await this.getPoolRoot();
    if (deposits.length > 0 && tree.root() !== onChainRoot) {
      console.warn(
        `[PrivacyPoolsAdapter] Local tree root ${tree.root()} != on-chain root ${onChainRoot}. ` +
        `A deposit may have arrived between our event fetch and root query. ` +
        `Re-fetching deposits is advisable before generating a proof.`
      );
    }

    return { root: onChainRoot, tree, leafIndex, deposits };
  }

  /**
   * Fetch all Deposit events from the pool contract.
   *
   * Events are returned in chronological order (ascending block number).
   * The commitment for each deposit is reconstructed from keys[2..3] (u256).
   */
  async fetchAllDeposits(): Promise<DepositEvent[]> {
    // Paginate through all Deposit events — starknet_getEvents returns at most
    // chunk_size=1000 events per call. If continuation_token is present, more
    // pages follow. Without pagination, pools with >1000 deposits would produce
    // a truncated (wrong) Merkle tree, generating proofs that the on-chain
    // verifier rejects.
    type RawEvent = {
      keys: string[];
      data: string[];
      block_number: number;
      transaction_hash: string;
      from_address: string;
    };

    const allEvents: RawEvent[] = [];
    let continuationToken: string | undefined;

    do {
      const params: Record<string, unknown> = {
        address: this.poolAddress,
        keys: [[DEPOSIT_SELECTOR]],
        from_block: { block_number: 0 },
        to_block: 'pending',
        chunk_size: 1000,
      };
      if (continuationToken) {
        params.continuation_token = continuationToken;
      }

      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'starknet_getEvents',
          params: [params],
          id: 1,
        }),
      });

      const data = await response.json() as {
        result?: { events: RawEvent[]; continuation_token?: string };
        error?: unknown;
      };

      if (data.error) {
        throw new Error(`starknet_getEvents failed: ${JSON.stringify(data.error)}`);
      }

      allEvents.push(...(data.result?.events ?? []));
      continuationToken = data.result?.continuation_token;
    } while (continuationToken);

    const events = allEvents;

    return events.map((e) => {
      // Event layout (from pool.cairo Deposit event struct):
      // keys[0] = selector
      // keys[1] = caller (depositor address) — ContractAddress, #[key]
      // keys[2] = secret_and_nullifier_hash low  (u256 low word, #[key])  ← NOT the leaf
      // keys[3] = secret_and_nullifier_hash high (u256 high word, #[key])
      // data[0] = amount low
      // data[1] = amount high
      //
      // IMPORTANT: pool.deposit(secret_and_nullifier_hash, amount) stores
      //   commitment = hash(secret_and_nullifier_hash, amount)   ← this is the Merkle leaf
      // The event emits secret_and_nullifier_hash (not the commitment).
      // We must reconstruct the commitment to rebuild the tree correctly.
      const snhLow = BigInt(e.keys[2] ?? '0');
      const snhHigh = BigInt(e.keys[3] ?? '0');
      const secretAndNullifierHash = snhLow + (snhHigh << 128n);

      const amountLow = BigInt(e.data[0] ?? '0');
      const amountHigh = BigInt(e.data[1] ?? '0');
      const amount = amountLow + (amountHigh << 128n);

      // Reconstruct the actual Merkle leaf: hash(secret_and_nullifier_hash, amount)
      const commitment = poseidonHash(secretAndNullifierHash, amount);

      return {
        commitment,
        amount,
        depositorAddress: e.keys[1] ?? '',
        blockNumber: e.block_number,
        txHash: e.transaction_hash,
      };
    });
  }

  /**
   * Get the current Merkle root from the pool contract.
   * current_root() returns u256 → two felt252 values (low, high).
   */
  async getPoolRoot(): Promise<bigint> {
    const result = await this.provider.callContract({
      contractAddress: this.poolAddress,
      entrypoint: 'current_root',
      calldata: [],
    });

    const low = BigInt(result[0]);
    const high = BigInt(result[1] ?? '0');
    return low + (high << 128n);
  }

  /**
   * After depositing, resolve the leaf index for the note.
   * Call this after the deposit transaction is confirmed.
   */
  async findNoteInTree(note: Note): Promise<number> {
    const { leafIndex } = await this.buildPoolState(note.commitment);
    return leafIndex;
  }

  async generateAuditProof(): Promise<AuditProof> {
    throw new Error(
      'PrivacyPoolsAdapter does not support audit proofs. ' +
      'Use STRK20Adapter with viewing keys for compliance.'
    );
  }
}

/** Generate a cryptographically random felt252 value (31 bytes < BN254 field size) */
function randomFelt(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}
