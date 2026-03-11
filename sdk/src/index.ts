// Wraith Protocol — Agent SDK for private AI payments on Starknet
export { WraithAgent } from './agent.js';
export { encryptNoteForAPI, decryptNoteFromAgent } from './lit.js';
export type { EncryptedNote, DecryptedNote } from './lit.js';
export { PrivacyPoolsAdapter } from './adapters/privacy-pools.js';
export { STRK20Adapter } from './adapters/strk20.js';
export { PaymentBatcher } from './batcher.js';
export {
  parseChallenge,
  buildPaymentHeader,
  parsePaymentHeader,
  verifyDepositOnChain,
  X402_SCHEME,
} from './x402.js';
export {
  createAgentManifest,
  manifestToDataURI,
  generatePaymentReceipt,
  validateReceipt,
} from './erc8004.js';
export type {
  AgentManifest,
  AgentReceipt,
  ERC8004Config,
  ServiceEntry,
} from './erc8004.js';
export type {
  WraithConfig,
  Note,
  PaymentIntent,
  PaymentReceipt,
  PrivacyScore,
  AuditProof,
  X402Challenge,
  X402PaymentProof,
  IPrivacyAdapter,
} from './types.js';
