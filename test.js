'use strict';

const { createWallet, parseNwcUrl, decodeBolt11, NWCWallet } = require('./lib');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
    failed++;
    console.log(`  ❌ ${message} (did not throw)`);
  } catch (_) {
    passed++;
    console.log(`  ✅ ${message}`);
  }
}

// ─── NWC URL Parsing ───
console.log('\n📡 NWC URL Parsing');

const testNwcUrl = 'nostr+walletconnect://962852f75958e8920c8dfeffd59baa8a75bc7029143a7cea82875772863b0721?relay=wss://relay.getalby.com/v1&secret=7ed367a99f9bde637f4f960f398ab310aaadb0e10ff8273ca6f97e136146272f';

const parsed = parseNwcUrl(testNwcUrl);
assert(parsed.walletPubkey === '962852f75958e8920c8dfeffd59baa8a75bc7029143a7cea82875772863b0721', 'extracts walletPubkey');
assert(parsed.relay === 'wss://relay.getalby.com/v1', 'extracts relay URL');
assert(parsed.secret === '7ed367a99f9bde637f4f960f398ab310aaadb0e10ff8273ca6f97e136146272f', 'extracts secret');

assertThrows(() => parseNwcUrl('https://example.com'), 'rejects non-NWC URL');
assertThrows(() => parseNwcUrl(''), 'rejects empty string');
assertThrows(() => parseNwcUrl(null), 'rejects null');
assertThrows(
  () => parseNwcUrl('nostr+walletconnect://abc?relay=wss://x.com&secret=abc'),
  'rejects bad pubkey length'
);
assertThrows(
  () => parseNwcUrl('nostr+walletconnect://962852f75958e8920c8dfeffd59baa8a75bc7029143a7cea82875772863b0721?secret=7ed367a99f9bde637f4f960f398ab310aaadb0e10ff8273ca6f97e136146272f'),
  'rejects missing relay'
);

// ─── Bolt11 Decoding ───
console.log('\n⚡ Bolt11 Amount Decoding');

// lnbc1u = 1 micro-BTC = 100 sats
const d1 = decodeBolt11('lnbc1u1ptest');
assert(d1.amountSats === 100, 'lnbc1u = 100 sats');

// lnbc210n = 210 nano-BTC = 21 sats
const d2 = decodeBolt11('lnbc210n1ptest');
assert(d2.amountSats === 21, 'lnbc210n = 21 sats');

// lnbc50u = 50 micro-BTC = 5000 sats
const d3 = decodeBolt11('lnbc50u1ptest');
assert(d3.amountSats === 5000, 'lnbc50u = 5000 sats');

// lnbc1m = 1 milli-BTC = 100000 sats
const d4 = decodeBolt11('lnbc1m1ptest');
assert(d4.amountSats === 100000, 'lnbc1m = 100000 sats');

// lnbc100n = 100 nano-BTC = 10 sats
const d5 = decodeBolt11('lnbc100n1ptest');
assert(d5.amountSats === 10, 'lnbc100n = 10 sats');

// lnbc2500u = 2500 micro-BTC = 250000 sats
const d6 = decodeBolt11('lnbc2500u1ptest');
assert(d6.amountSats === 250000, 'lnbc2500u = 250000 sats');

// lnbc10m = 10 milli-BTC = 1000000 sats
const d7 = decodeBolt11('lnbc10m1ptest');
assert(d7.amountSats === 1000000, 'lnbc10m = 1000000 sats');

// lnbc1500p = 1500 pico-BTC = 0.15 sats ≈ 0 sats (rounds)
const d8 = decodeBolt11('lnbc1500p1ptest');
assert(d8.amountSats === 0, 'lnbc1500p = 0 sats (sub-sat)');

// lnbc20n = 20 nano-BTC = 2 sats
const d9 = decodeBolt11('lnbc20n1ptest');
assert(d9.amountSats === 2, 'lnbc20n = 2 sats');

// Network detection
console.log('\n🌐 Network Detection');
assert(decodeBolt11('lnbc50u1ptest').network === 'mainnet', 'lnbc = mainnet');
assert(decodeBolt11('lntb50u1ptest').network === 'testnet', 'lntb = testnet');

// No amount (zero-amount invoice)
const d10 = decodeBolt11('lnbc1ptesttesttest');
assert(d10.amountSats === null, 'lnbc with no amount = null');

// Error cases
console.log('\n🚫 Bolt11 Error Cases');
assertThrows(() => decodeBolt11(''), 'rejects empty string');
assertThrows(() => decodeBolt11(null), 'rejects null');
assertThrows(() => decodeBolt11('notaninvoice'), 'rejects garbage');

// ─── createWallet interface ───
console.log('\n🔧 createWallet Interface');

const wallet = new NWCWallet(testNwcUrl);
assert(typeof wallet.getBalance === 'function', 'has getBalance()');
assert(typeof wallet.createInvoice === 'function', 'has createInvoice()');
assert(typeof wallet.payInvoice === 'function', 'has payInvoice()');
assert(typeof wallet.waitForPayment === 'function', 'has waitForPayment()');
assert(typeof wallet.decodeInvoice === 'function', 'has decodeInvoice()');
assert(typeof wallet.close === 'function', 'has close()');

// Test decodeInvoice works via wallet instance
const decoded = wallet.decodeInvoice('lnbc50u1ptest');
assert(decoded.amountSats === 5000, 'wallet.decodeInvoice works');
wallet.close();

// createWallet from env
console.log('\n🌍 createWallet from env');
process.env.NWC_URL = testNwcUrl;
const walletFromEnv = createWallet();
assert(walletFromEnv instanceof NWCWallet, 'createWallet() reads NWC_URL env');
walletFromEnv.close();
delete process.env.NWC_URL;

assertThrows(() => createWallet(), 'createWallet() throws without URL or env');

// ─── Summary ───
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed! ✅');
}
