'use strict';

const { createWallet, parseNwcUrl, decodeBolt11, resolveLightningAddress, NWCWallet } = require('./wallet');
const { createAuthServer, signAuth, authenticate } = require('./auth');
const { createEscrowManager, State: EscrowState } = require('./escrow');
const { createStreamProvider, createStreamClient } = require('./stream');

module.exports = {
  // Wallet (v0.1.0)
  createWallet,
  parseNwcUrl,
  decodeBolt11,
  resolveLightningAddress,
  NWCWallet,

  // Auth (v0.3.0)
  createAuthServer,
  signAuth,
  authenticate,

  // Escrow (v0.3.0)
  createEscrowManager,
  EscrowState,

  // Streaming payments (v0.3.0)
  createStreamProvider,
  createStreamClient
};
