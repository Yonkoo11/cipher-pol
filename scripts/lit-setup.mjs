#!/usr/bin/env node
/**
 * One-time Lit Protocol setup script.
 *
 * Creates a persistent test wallet, mints a Capacity Credits NFT on Chronicle
 * Yellowstone, and saves the token ID to .lit-capacity.json.
 *
 * Cost: ~0.0000000001 tstLPX per test run (negligible).
 * Faucet: https://chronicle-yellowstone-faucet.getlit.dev/  (0.01 tstLPX, lasts thousands of runs)
 *
 * Usage:
 *   node scripts/lit-setup.mjs          # first run: creates wallet, asks you to fund it
 *   node scripts/lit-setup.mjs          # second run: mints capacity credits
 *   node scripts/lit-setup.mjs --status # check balance + saved token
 */

import { LitContracts } from '@lit-protocol/contracts-sdk';
import { LIT_RPC } from '@lit-protocol/constants';
import { ethers } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '..');
const WALLET_FILE   = join(ROOT, '.lit-test-wallet.json');
const CAPACITY_FILE = join(ROOT, '.lit-capacity.json');

const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const CYAN  = s => `\x1b[36m${s}\x1b[0m`;
const RED   = s => `\x1b[31m${s}\x1b[0m`;
const BOLD  = s => `\x1b[1m${s}\x1b[0m`;

// ── Chronicle Yellowstone provider ───────────────────────────────────────────
const provider = new ethers.providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE);

// ── Load or create persistent test wallet ────────────────────────────────────
function loadOrCreateWallet() {
  if (existsSync(WALLET_FILE)) {
    const saved = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
    const wallet = new ethers.Wallet(saved.privateKey, provider);
    console.log(CYAN(`Loaded existing test wallet: ${wallet.address}`));
    return wallet;
  }
  const wallet = ethers.Wallet.createRandom().connect(provider);
  writeFileSync(WALLET_FILE, JSON.stringify({ privateKey: wallet.privateKey }), 'utf8');
  console.log(GREEN(`Created new test wallet: ${wallet.address}`));
  console.log(`Saved to: ${WALLET_FILE}`);
  return wallet;
}

// ── Next UTC midnight (required by Lit's RateLimit contract) ─────────────────
function nextMidnightUTC(daysFromNow = 2) {
  const d = new Date();
  return Math.floor(
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysFromNow)).getTime() / 1000
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
const statusOnly = process.argv.includes('--status');

const wallet = loadOrCreateWallet();

// Check balance
const balance = await provider.getBalance(wallet.address);
const balanceEth = parseFloat(ethers.utils.formatEther(balance));
console.log(`\nChronicle Yellowstone balance: ${BOLD(balanceEth.toFixed(18))} tstLPX`);

// Check existing capacity token
if (existsSync(CAPACITY_FILE)) {
  const saved = JSON.parse(readFileSync(CAPACITY_FILE, 'utf8'));
  console.log(GREEN(`\nCapacity Credits NFT already minted:`));
  console.log(`  Token ID  : ${BOLD(saved.tokenId)}`);
  console.log(`  Minted at : ${saved.mintedAt}`);
  console.log(`  Expires   : ${saved.expiresAt}`);
  if (statusOnly) process.exit(0);
  console.log('\nNothing to do — capacity credits already set up.');
  console.log(`Run tests with: node tests/lit.test.mjs`);
  process.exit(0);
}

if (statusOnly) {
  console.log('\nNo capacity credits minted yet.');
  process.exit(0);
}

// Need tstLPX to mint
if (balanceEth < 0.000001) {
  console.log(RED('\n⚠  Wallet has no tstLPX — cannot mint Capacity Credits.'));
  console.log('\n' + BOLD('To set up Lit Capacity Credits (one-time):'));
  console.log(`  1. Go to: ${CYAN('https://chronicle-yellowstone-faucet.getlit.dev/')}`);
  console.log(`  2. Paste this address: ${BOLD(wallet.address)}`);
  console.log(`  3. Click "Get 0.01 tstLPX"`);
  console.log(`  4. Re-run: ${CYAN('node scripts/lit-setup.mjs')}`);
  console.log('\n0.01 tstLPX is enough for thousands of test runs (each costs ~0.0000000001 tstLPX).');
  process.exit(0);
}

// ── Mint Capacity Credits ─────────────────────────────────────────────────────
console.log('\nConnecting to Lit contracts on Chronicle Yellowstone...');
const litContracts = new LitContracts({
  network: 'datil',
  signer: wallet,
  debug: false,
});
await litContracts.connect();

const expiresTs = nextMidnightUTC(2); // 2 days from now
const expiresDate = new Date(expiresTs * 1000).toISOString();

// Calculate cost first
const cost = await litContracts.rateLimitNftContract.read.calculateCost(1, expiresTs);
console.log(`Minting Capacity Credits NFT:`);
console.log(`  Rate        : 1 request/kilosecond`);
console.log(`  Expires     : ${expiresDate}`);
console.log(`  Cost        : ${ethers.utils.formatEther(cost)} tstLPX`);

console.log('\nSending mint transaction...');
const { tx, tokenId } = await litContracts.mintCapacityCreditsNFT({
  requestsPerKilosecond: 1,
  daysUntilUTCMidnightExpiration: 2,
});
const receipt = await tx.wait();

const tokenIdDecimal = tokenId ? BigInt(tokenId).toString() : 'unknown';
console.log(GREEN(`\nCapacity Credits NFT minted!`));
console.log(`  Token ID    : ${BOLD(tokenIdDecimal)}`);
console.log(`  Tx hash     : ${receipt.transactionHash}`);
console.log(`  Expires     : ${expiresDate}`);

// Save to file
const saved = {
  tokenId: tokenIdDecimal,
  walletAddress: wallet.address,
  mintedAt: new Date().toISOString(),
  expiresAt: expiresDate,
  txHash: receipt.transactionHash,
};
writeFileSync(CAPACITY_FILE, JSON.stringify(saved, null, 2), 'utf8');
console.log(GREEN(`\nSaved to: ${CAPACITY_FILE}`));
console.log(`\nRun the Lit roundtrip test: ${CYAN('node tests/lit.test.mjs')}`);
