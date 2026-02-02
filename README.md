# ⚡ lightning-agent

Lightning payments for AI agents. Two functions: charge and pay.

A tiny SDK that gives any AI agent the ability to send and receive Bitcoin Lightning payments using [Nostr Wallet Connect (NWC)](https://nwc.dev). No browser, no UI — just code. Connect your agent to an NWC-compatible wallet (Alby Hub, Mutiny, etc.) and start transacting in sats.

## Install

```bash
npm install lightning-agent
```

## Quick Start

```javascript
const { createWallet } = require('lightning-agent');

const wallet = createWallet('nostr+walletconnect://...');

// Check balance
const { balanceSats } = await wallet.getBalance();
console.log(`Balance: ${balanceSats} sats`);

// Create an invoice (get paid)
const { invoice, paymentHash } = await wallet.createInvoice({
  amountSats: 50,
  description: 'Text generation query'
});
console.log(`Pay me: ${invoice}`);

// Wait for payment
const { paid } = await wallet.waitForPayment(paymentHash, { timeoutMs: 60000 });

// Pay an invoice (spend)
const { preimage } = await wallet.payInvoice(someInvoice);

// Or pay a Lightning address directly
await wallet.payAddress('alice@getalby.com', { amountSats: 10 });

// Done
wallet.close();
```

## API Reference

### `createWallet(nwcUrl?)`

Create a wallet instance. Pass an NWC URL directly or set the `NWC_URL` environment variable.

```javascript
const wallet = createWallet('nostr+walletconnect://...');
// or
process.env.NWC_URL = 'nostr+walletconnect://...';
const wallet = createWallet();
```

### `wallet.getBalance(opts?)`

Get the wallet balance.

```javascript
const { balanceSats, balanceMsats } = await wallet.getBalance();
```

**Options:** `{ timeoutMs: 15000 }`

### `wallet.createInvoice(opts)`

Create a Lightning invoice (receive payment).

```javascript
const { invoice, paymentHash, amountSats } = await wallet.createInvoice({
  amountSats: 100,
  description: 'API call fee',
  expiry: 3600,        // optional, seconds
  timeoutMs: 15000     // optional
});
```

### `wallet.payInvoice(invoice, opts?)`

Pay a Lightning invoice.

```javascript
const { preimage, paymentHash } = await wallet.payInvoice('lnbc50u1p...');
```

**Options:** `{ timeoutMs: 30000 }`

### `wallet.payAddress(address, opts)`

Pay a Lightning address (user@domain) via LNURL-pay. Resolves the address to an invoice and pays it in one call.

```javascript
const result = await wallet.payAddress('alice@getalby.com', {
  amountSats: 100,
  comment: 'Great work!',  // optional
  timeoutMs: 30000          // optional
});
// { preimage, paymentHash, invoice, amountSats }
```

### `wallet.waitForPayment(paymentHash, opts?)`

Poll until an invoice is paid (or timeout).

```javascript
const { paid, preimage, settledAt } = await wallet.waitForPayment(hash, {
  timeoutMs: 60000,      // total wait (default 60s)
  pollIntervalMs: 2000   // poll frequency (default 2s)
});
```

### `wallet.decodeInvoice(invoice)`

Decode a bolt11 invoice offline (no wallet connection needed). Extracts amount and network.

```javascript
const { amountSats, network } = wallet.decodeInvoice('lnbc50u1p...');
// { amountSats: 5000, network: 'mainnet', description: null, paymentHash: null }
```

### `wallet.close()`

Close the relay connection. Call when done.

### `resolveLightningAddress(address, amountSats, comment?)`

Resolve a Lightning address to a bolt11 invoice without paying (useful for inspection).

```javascript
const { resolveLightningAddress } = require('lightning-agent');
const { invoice, minSats, maxSats } = await resolveLightningAddress('bob@walletofsatoshi.com', 50);
```

### `decodeBolt11(invoice)`

Standalone bolt11 decoder (no wallet instance needed).

```javascript
const { decodeBolt11 } = require('lightning-agent');
const { amountSats } = decodeBolt11('lnbc210n1p...');
// amountSats = 21
```

### `parseNwcUrl(url)`

Parse an NWC URL into its components.

```javascript
const { parseNwcUrl } = require('lightning-agent');
const { walletPubkey, relay, secret } = parseNwcUrl('nostr+walletconnect://...');
```

## CLI

```bash
# Set your NWC URL
export NWC_URL="nostr+walletconnect://..."

# Check balance
lightning-agent balance

# Create an invoice for 50 sats
lightning-agent invoice 50 "Text generation query"

# Pay an invoice
lightning-agent pay lnbc50u1p...

# Decode an invoice (offline)
lightning-agent decode lnbc50u1p...

# Wait for a payment
lightning-agent wait <payment_hash> [timeout_ms]
```

## Getting an NWC URL

You need a Nostr Wallet Connect URL from a compatible wallet:

- **[Alby Hub](https://albyhub.com)** — Self-hosted Lightning node with NWC. Recommended for agents.
- **[Mutiny Wallet](https://mutinywallet.com)** — Mobile-first with NWC support.
- **[Coinos](https://coinos.io)** — Web wallet with NWC.

The URL looks like: `nostr+walletconnect://<wallet_pubkey>?relay=wss://...&secret=<hex>`

## How It Works

lightning-agent uses the [NWC protocol (NIP-47)](https://github.com/nostr-protocol/nips/blob/master/47.md):

1. Your agent signs NWC requests (kind 23194) with the secret from the NWC URL
2. Requests are encrypted with NIP-04 and sent to the wallet's relay
3. The wallet service processes the request and returns an encrypted response (kind 23195)
4. All communication happens over Nostr relays — no direct connection to the wallet needed

## Design Philosophy

This is built for AI agents, not humans:

- **Minimal deps** — just `nostr-tools` and `ws`
- **No UI** — pure code, works in any Node.js environment
- **Reliable connections** — fresh relay connection per request for maximum reliability
- **Timeouts everywhere** — agents can't afford to hang
- **Simple API** — `createInvoice` to charge, `payInvoice` to pay

## License

MIT
