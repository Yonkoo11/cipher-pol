/**
 * Lit Protocol integration — encrypt (secret, nullifier) bundles for x402 flow
 *
 * Why Lit Protocol:
 * - Agent deposits into privacy pool (deposit tx hash is public)
 * - Agent needs to send (secret, nullifier) to the API so it can generate the withdrawal proof
 * - Sending these in plaintext defeats the privacy guarantee
 * - Lit encrypts the bundle so only the API (owner of withdrawalAddress) can decrypt
 * - David Sneider (Lit co-founder) is a PL Genesis judge — this is also strategic
 *
 * Access condition:
 * - The API server must be the holder of withdrawalAddress on Starknet
 * - OR: the API authenticates with a Lit session signature
 * - We use the simplest path: condition = "must sign with API's Starknet address"
 *
 * SDK version: v7 (@lit-protocol/lit-node-client, @lit-protocol/encryption)
 * Packages needed:
 *   npm install @lit-protocol/lit-node-client @lit-protocol/encryption @lit-protocol/constants @lit-protocol/auth-helpers
 *
 * NOTE: Lit SDK is NOT installed in the current package.json.
 * The current package.json has @lit-protocol/lit-node-client@^6.6.2 which is outdated.
 * Update to v7 before using this module.
 * Also: Lit v7 does not support Node.js ESM cleanly — may need --experimental-vm-modules
 * or switch to CJS for the server target.
 */

export interface EncryptedNote {
  ciphertext: string;
  dataToEncryptHash: string;
  accessControlConditions: unknown[];
  chain: string;
}

export interface DecryptedNote {
  secret: bigint;
  nullifier: bigint;
}

/**
 * Encrypt (secret, nullifier) for the API server.
 *
 * @param secret          - The deposit secret
 * @param nullifier       - The deposit nullifier
 * @param apiEthAddress   - Ethereum address of the API server (who can decrypt).
 *                          Must be the address corresponding to the server's
 *                          SERVER_ETH_PRIVATE_KEY. Do NOT derive this from a
 *                          Starknet address — use ethers.Wallet(pk).address.
 * @param litNetwork      - Lit network ('datil' for production, 'datil-dev' for local)
 */
export async function encryptNoteForAPI(
  secret: bigint,
  nullifier: bigint,
  apiEthAddress: string,
  litNetwork: string = 'datil'
): Promise<EncryptedNote> {
  if (!apiEthAddress.match(/^0x[0-9a-fA-F]{40}$/)) {
    throw new Error(
      `apiEthAddress must be a 20-byte Ethereum address (0x + 40 hex chars). ` +
      `Got: ${apiEthAddress}. ` +
      `Use ethers.Wallet(SERVER_ETH_PRIVATE_KEY).address — do not derive from Starknet address.`
    );
  }

  const { LitNodeClient } = await import('@lit-protocol/lit-node-client');
  const { encryptString } = await import('@lit-protocol/encryption');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new LitNodeClient({ litNetwork: litNetwork as any, debug: false });
  await client.connect();

  // Access condition: only the holder of apiEthAddress can decrypt.
  // Lit verifies this via a SIWE signature from the decryptor.
  // Note: Lit does not yet support native Starknet access conditions (as of v7.4).
  // The API server authenticates with a dedicated Ethereum key (SERVER_ETH_PRIVATE_KEY).
  const accessControlConditions = [
    {
      contractAddress: '',
      standardContractType: '',
      chain: 'ethereum',
      method: '',
      parameters: [':userAddress'],
      returnValueTest: {
        comparator: '=',
        value: apiEthAddress.toLowerCase(),
      },
    },
  ];

  const message = JSON.stringify({
    secret: secret.toString(16),
    nullifier: nullifier.toString(16),
  });

  const { ciphertext, dataToEncryptHash } = await encryptString(
    { accessControlConditions, dataToEncrypt: message },
    client
  );

  await client.disconnect();

  return {
    ciphertext,
    dataToEncryptHash,
    accessControlConditions,
    chain: 'ethereum',
  };
}

/**
 * Decrypt a (secret, nullifier) bundle.
 * Called by the API server to get the note data for withdrawal proof generation.
 *
 * @param encrypted - The encrypted bundle from the agent
 * @param sessionSigs - Lit session signatures (API server must authenticate)
 */
export async function decryptNoteFromAgent(
  encrypted: EncryptedNote,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionSigs: any
): Promise<DecryptedNote> {
  const { LitNodeClient } = await import('@lit-protocol/lit-node-client');
  const { decryptToString } = await import('@lit-protocol/encryption');

  const client = new LitNodeClient({ litNetwork: 'datil', debug: false });
  await client.connect();

  const decrypted = await decryptToString(
    {
      accessControlConditions: encrypted.accessControlConditions,
      ciphertext: encrypted.ciphertext,
      dataToEncryptHash: encrypted.dataToEncryptHash,
      chain: encrypted.chain,
      sessionSigs,
    },
    client
  );

  await client.disconnect();

  const parsed = JSON.parse(decrypted);
  return {
    secret: BigInt('0x' + parsed.secret),
    nullifier: BigInt('0x' + parsed.nullifier),
  };
}

