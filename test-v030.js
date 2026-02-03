#!/usr/bin/env node
'use strict';

/**
 * Tests for lightning-agent v0.3.0 new features.
 * Tests auth, escrow, and stream modules.
 */

const {
  createAuthServer, signAuth, authenticate,
  createEscrowManager, EscrowState,
  createStreamProvider, createStreamClient
} = require('./lib/index');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

// ─── Auth Tests ───

console.log('\n🔐 Auth Module');

(function testAuthServer() {
  console.log('\n  createAuthServer:');
  
  const auth = createAuthServer({ challengeTtlMs: 5000 });
  
  // Create challenge
  const challenge = auth.createChallenge();
  assert(challenge.k1 && challenge.k1.length === 64, 'Challenge has 64-char hex k1');
  assert(challenge.expiresAt > Date.now(), 'Challenge has future expiry');
  assert(auth.activeChallenges === 1, 'Active challenges count is 1');
  
  // Verify with missing params
  const bad = auth.verify(null, null, null);
  assert(!bad.valid, 'Rejects null params');
  assert(bad.error === 'Missing k1, sig, or key', 'Correct error message');

  // Verify with wrong k1
  const bad2 = auth.verify('deadbeef'.repeat(8), 'aabb', 'ccdd');
  assert(!bad2.valid, 'Rejects unknown k1');
  
  console.log('  Active challenges:', auth.activeChallenges);
})();

(function testSignAuth() {
  console.log('\n  signAuth + verify roundtrip:');
  
  const crypto = require('crypto');
  const privKey = crypto.randomBytes(32).toString('hex');
  
  const auth = createAuthServer();
  const challenge = auth.createChallenge();
  
  try {
    const { sig, key } = signAuth(challenge.k1, privKey);
    assert(sig && sig.length > 0, 'Signature generated');
    assert(key && key.length === 66, 'Compressed pubkey (33 bytes hex)');
    
    const result = auth.verify(challenge.k1, sig, key);
    assert(result.valid === true, 'Signature verified ✓');
    assert(result.pubkey === key, 'Returns correct pubkey');
    
    // Replay protection
    const replay = auth.verify(challenge.k1, sig, key);
    assert(!replay.valid, 'Rejects replay (challenge already used)');
  } catch (err) {
    assert(false, 'Sign/verify failed: ' + err.message);
  }
})();

(function testAuthWithLnurl() {
  console.log('\n  LNURL generation:');
  
  const auth = createAuthServer({ callbackUrl: 'https://example.com/auth' });
  const challenge = auth.createChallenge();
  
  assert(challenge.lnurl && challenge.lnurl.startsWith('lnurl'), 'LNURL generated');
  assert(challenge.callbackUrl.includes('k1='), 'Callback URL has k1');
  assert(challenge.callbackUrl.includes('tag=login'), 'Callback URL has tag=login');
})();

(function testAuthMiddleware() {
  console.log('\n  Middleware:');
  
  const auth = createAuthServer();
  const handler = auth.middleware((pubkey, req, res) => {
    // onAuth callback
  });
  assert(typeof handler === 'function', 'Middleware returns function');
})();

// ─── Escrow Tests ───

console.log('\n\n💰 Escrow Module');

(function testEscrowStates() {
  console.log('\n  EscrowState:');
  assert(EscrowState.CREATED === 'created', 'CREATED state');
  assert(EscrowState.FUNDED === 'funded', 'FUNDED state');
  assert(EscrowState.RELEASED === 'released', 'RELEASED state');
  assert(EscrowState.REFUNDED === 'refunded', 'REFUNDED state');
  assert(EscrowState.EXPIRED === 'expired', 'EXPIRED state');
  assert(EscrowState.DISPUTED === 'disputed', 'DISPUTED state');
})();

(async function testEscrowCreate() {
  console.log('\n  createEscrowManager:');
  
  // Mock wallet
  const mockWallet = {
    createInvoice: async (opts) => ({
      invoice: 'lnbc' + opts.amountSats + 'n1mock',
      paymentHash: require('crypto').randomBytes(32).toString('hex'),
      amountSats: opts.amountSats
    }),
    waitForPayment: async () => ({ paid: true, preimage: 'abc123' }),
    payInvoice: async () => ({ preimage: 'def456', paymentHash: 'hash456' }),
    payAddress: async (addr, opts) => ({
      preimage: 'ghi789',
      paymentHash: 'hash789',
      invoice: 'lnbcmock',
      amountSats: opts.amountSats
    })
  };

  const stateChanges = [];
  const mgr = createEscrowManager(mockWallet, {
    onStateChange: (id, from, to) => stateChanges.push({ id, from, to })
  });

  // Create escrow
  const escrow = await mgr.create({
    amountSats: 500,
    workerAddress: 'worker@getalby.com',
    description: 'Test work',
    deadlineMs: 60000
  });

  assert(escrow.id && escrow.id.length === 32, 'Escrow ID generated');
  assert(escrow.state === 'created', 'Initial state is created');
  assert(escrow.amountSats === 500, 'Amount correct');
  assert(escrow.invoice.startsWith('lnbc'), 'Invoice generated');
  assert(escrow.deadline > Date.now(), 'Deadline set');

  // Fund
  const funded = await mgr.fund(escrow.id);
  assert(funded.state === 'funded', 'State transitions to funded');
  assert(funded.fundedAt > 0, 'Funded timestamp set');

  // Deliver
  const delivered = mgr.deliver(escrow.id, { hash: 'sha256ofwork' });
  assert(delivered.state === 'delivered', 'State transitions to delivered');
  assert(delivered.deliveryProof.hash === 'sha256ofwork', 'Proof stored');

  // Release
  const released = await mgr.release(escrow.id);
  assert(released.state === 'released', 'State transitions to released');
  assert(released.releasePreimage === 'ghi789', 'Release preimage stored');

  // History
  assert(released.history.length === 4, 'Full history (4 transitions)');
  assert(stateChanges.length === 3, 'State change callbacks fired (3)');

  // List
  const all = mgr.list();
  assert(all.length === 1, 'List returns 1 escrow');
  const releasedList = mgr.list('released');
  assert(releasedList.length === 1, 'Filtered list works');

  mgr.close();
})().catch(e => { failed++; console.log('  ❌ Escrow test error:', e.message); });

(async function testEscrowRefund() {
  console.log('\n  Escrow refund flow:');
  
  const mockWallet = {
    createInvoice: async (opts) => ({
      invoice: 'lnbcmock',
      paymentHash: require('crypto').randomBytes(32).toString('hex')
    }),
    waitForPayment: async () => ({ paid: true }),
    payAddress: async () => ({ preimage: 'refund123' })
  };

  const mgr = createEscrowManager(mockWallet);
  const escrow = await mgr.create({
    amountSats: 200,
    workerAddress: 'worker@example.com',
    deadlineMs: 60000
  });

  await mgr.fund(escrow.id);
  const refunded = await mgr.refund(escrow.id, 'client@getalby.com', 'Worker no-show');
  
  assert(refunded.state === 'refunded', 'Refund succeeds');
  assert(refunded.metadata.refundReason === 'Worker no-show', 'Refund reason stored');
  
  mgr.close();
})().catch(e => { failed++; console.log('  ❌ Escrow refund error:', e.message); });

(async function testEscrowDispute() {
  console.log('\n  Escrow dispute:');

  const mockWallet = {
    createInvoice: async () => ({
      invoice: 'lnbcmock',
      paymentHash: require('crypto').randomBytes(32).toString('hex')
    }),
    waitForPayment: async () => ({ paid: true })
  };

  const mgr = createEscrowManager(mockWallet);
  const escrow = await mgr.create({
    amountSats: 1000,
    workerAddress: 'worker@example.com'
  });

  await mgr.fund(escrow.id);
  const disputed = mgr.dispute(escrow.id, 'Work quality insufficient', 'client');
  
  assert(disputed.state === 'disputed', 'Dispute state set');
  assert(disputed.metadata.dispute.reason === 'Work quality insufficient', 'Dispute reason stored');
  assert(disputed.metadata.dispute.raisedBy === 'client', 'Dispute raiser stored');
  
  mgr.close();
})().catch(e => { failed++; console.log('  ❌ Escrow dispute error:', e.message); });

// ─── Stream Tests ───

console.log('\n\n⚡ Stream Module');

(function testStreamProvider() {
  console.log('\n  createStreamProvider:');
  
  const mockWallet = {
    createInvoice: async (opts) => ({
      invoice: 'lnbc1n1mock',
      paymentHash: require('crypto').randomBytes(32).toString('hex')
    }),
    waitForPayment: async () => ({ paid: true })
  };

  const provider = createStreamProvider(mockWallet, {
    satsPerBatch: 2,
    tokensPerBatch: 50,
    maxBatches: 10
  });

  assert(typeof provider.handleRequest === 'function', 'Has handleRequest method');
  assert(provider.activeSessions === 0, 'No active sessions initially');
})();

(function testStreamClient() {
  console.log('\n  createStreamClient:');
  
  const mockWallet = {
    payInvoice: async () => ({ preimage: 'mock_preimage' })
  };

  const client = createStreamClient(mockWallet, { maxSats: 500 });
  
  assert(typeof client.stream === 'function', 'Has stream method');
  assert(client.budget.maxSats === 500, 'Budget set correctly');
})();

// ─── Summary ───

setTimeout(() => {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 500);
