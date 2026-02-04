# ⚡ lightning-agent

**Settle this transaction without a platform.**

You can't transact without a payment rail. lightning-agent is the rail — payments, auth, escrow, and streaming micropayments over [Nostr Wallet Connect (NWC)](https://nwc.dev). No browser, no UI, no bank accounts, no Stripe. Connect to any NWC-compatible wallet (Alby Hub, Mutiny, etc.) and two agents can exchange value directly.

Part of the constraint chain: [agent-discovery](https://github.com/jeletor/agent-discovery) (find) → [ai-wot](https://github.com/jeletor/ai-wot) (verify) → **lightning-agent** (pay) → [lightning-toll](https://github.com/jeletor/lightning-toll) (gate).

## Install

```bash
npm install lightning-agent
```

## What's in the box

| Module | What it does | Since |
|--------|-------------|-------|
| **Wallet** | Send/receive Lightning payments, decode invoices | v0.1.0 |
| **Auth** | LNURL-auth — login with your Lightning wallet | v0.3.0 |
| **Escrow** | Hold funds until work is verified, then release or refund | v0.3.0 |
| **Stream** | Pay-per-token streaming micropayments | v0.3.0 |

---

## Quick Start: Payments

```javascript
const { createWallet } = require('lightning-agent');

const wallet = createWallet('nostr+walletconnect://...');

// Check balance
const { balanceSats } = await wallet.getBalance();

// Create an invoice (get paid)
const { invoice, paymentHash } = await wallet.createInvoice({
  amountSats: 50,
  description: 'Text generation query'
});

// Wait for payment
const { paid } = await wallet.waitForPayment(paymentHash);

// Pay an invoice
const { preimage } = await wallet.payInvoice(someInvoice);

// Pay a Lightning address directly
await wallet.payAddress('alice@getalby.com', { amountSats: 10 });

wallet.close();
```

---

## Auth (LNURL-auth)

Login with a Lightning wallet. No passwords, no OAuth — just a signed cryptographic challenge.

### Server side

```javascript
const { createAuthServer, signAuth } = require('lightning-agent');

const auth = createAuthServer({
  callbackUrl: 'https://api.example.com/auth',
  challengeTtlMs: 300000 // 5 minutes
});

// Generate a challenge
const { k1, lnurl } = auth.createChallenge();
// → lnurl can be rendered as QR for wallet apps
// → k1 can be sent directly to agent clients

// Verify a signed response
const result = auth.verify(k1, sig, key);
// → { valid: true, pubkey: '03abc...' }

// Or use as Express middleware
app.get('/auth', auth.middleware((pubkey, req, res) => {
  console.log('Authenticated:', pubkey);
}));
```

### Client side (agent)

```javascript
const { signAuth, authenticate } = require('lightning-agent');

// Sign a challenge manually
const { sig, key } = signAuth(k1, myPrivateKeyHex);
// → Send sig + key back to server

// Or complete the full flow automatically
const result = await authenticate('lnurl1...', myPrivateKeyHex);
if (result.success) console.log('Logged in as', result.pubkey);
```

### API

#### `createAuthServer(opts?)`
- `opts.challengeTtlMs` — Challenge validity in ms (default 300000)
- `opts.callbackUrl` — Full URL for LNURL generation

Returns: `{ createChallenge(), verify(k1, sig, key), middleware(onAuth), activeChallenges }`

#### `signAuth(k1, privateKey)`
Sign a challenge with a secp256k1 private key. Returns `{ sig, key }` (DER signature + compressed pubkey).

#### `authenticate(lnurlOrUrl, privateKey)`
Complete an LNURL-auth flow: fetch challenge → sign → submit. Returns `{ success, pubkey, error? }`.

---

## Escrow

Hold funds until work is verified. Client pays into escrow → worker delivers → escrow releases payment. If the worker doesn't deliver, funds are refunded.

```javascript
const { createWallet, createEscrowManager } = require('lightning-agent');

const escrowWallet = createWallet('nostr+walletconnect://...');
const mgr = createEscrowManager(escrowWallet, {
  onStateChange: (id, from, to) => console.log(`${id}: ${from} → ${to}`)
});

// 1. Create escrow
const escrow = await mgr.create({
  amountSats: 500,
  workerAddress: 'worker@getalby.com',
  description: 'Translate 200 words EN→ES',
  deadlineMs: 3600000 // 1 hour
});
console.log('Client should pay:', escrow.invoice);

// 2. Confirm funding (waits for payment)
await mgr.fund(escrow.id);

// 3. Worker delivers proof
mgr.deliver(escrow.id, { url: 'https://example.com/result', hash: 'sha256...' });

// 4a. Release to worker
await mgr.release(escrow.id);

// 4b. Or refund to client
await mgr.refund(escrow.id, 'client@getalby.com', 'Worker no-show');

// 4c. Or dispute
mgr.dispute(escrow.id, 'Quality insufficient', 'client');
```

### Escrow states

```
CREATED → FUNDED → DELIVERED → RELEASED
                             → REFUNDED
                  → EXPIRED (auto, on deadline)
                  → DISPUTED
```

### API

#### `createEscrowManager(wallet, opts?)`
- `wallet` — NWC wallet that holds escrowed funds
- `opts.onStateChange(id, oldState, newState, escrow)` — State change callback
- `opts.defaultDeadlineMs` — Default deadline (default 3600000)

Returns: `{ create(config), fund(id, opts?), deliver(id, proof), release(id), refund(id, address, reason?), dispute(id, reason, raisedBy), get(id), list(state?), close() }`

#### `EscrowState`
Enum: `CREATED`, `FUNDED`, `DELIVERED`, `RELEASED`, `REFUNDED`, `EXPIRED`, `DISPUTED`

---

## Streaming Payments

Pay-per-token micropayments. Lightning is the only payment system that can handle fractions-of-a-cent per word.

### Provider (server)

```javascript
const { createWallet, createStreamProvider } = require('lightning-agent');
const http = require('http');

const wallet = createWallet('nostr+walletconnect://...');
const provider = createStreamProvider(wallet, {
  satsPerBatch: 2,       // charge 2 sats per batch
  tokensPerBatch: 100,   // 100 tokens per batch
  maxBatches: 50         // cap at 50 batches (100 sats max)
});

http.createServer(async (req, res) => {
  await provider.handleRequest(req, res, async function* () {
    // Your generator yields tokens/strings
    for (const word of myTextGenerator(req)) {
      yield word + ' ';
    }
  }, { firstBatchFree: true });
}).listen(8080);
```

### Client (consumer)

```javascript
const { createWallet, createStreamClient } = require('lightning-agent');

const wallet = createWallet('nostr+walletconnect://...');
const client = createStreamClient(wallet, { maxSats: 200 });

for await (const text of client.stream('https://api.example.com/generate', {
  body: { prompt: 'Explain Lightning Network in 500 words' },
  maxSats: 100 // budget for this stream
})) {
  process.stdout.write(text);
}
```

### SSE Protocol

The provider uses Server-Sent Events:

```
event: session    data: { "sessionId": "abc..." }
event: content    data: { "tokens": "Hello world...", "batchIndex": 1 }
event: invoice    data: { "invoice": "lnbc...", "sats": 2, "batchIndex": 2 }
event: content    data: { "tokens": "more text...", "batchIndex": 2 }
event: done       data: { "totalBatches": 5, "totalSats": 8, "totalTokens": 500 }
```

Client proves payment by POSTing `{ sessionId, preimage }` to the same URL.

### API

#### `createStreamProvider(wallet, opts?)`
- `opts.satsPerBatch` — Sats per batch (default 1)
- `opts.tokensPerBatch` — Tokens per batch (default 50)
- `opts.maxBatches` — Max batches per stream (default 100)
- `opts.paymentTimeoutMs` — Payment wait timeout (default 30000)

Returns: `{ handleRequest(req, res, generator, opts?), activeSessions }`

#### `createStreamClient(wallet, opts?)`
- `opts.maxSats` — Budget cap (default 1000)
- `opts.autoPay` — Auto-pay invoices (default true)

Returns: `{ stream(url, opts?), budget }`

---

## Wallet API Reference

### `createWallet(nwcUrl?)`
Create a wallet instance. Pass NWC URL directly or set `NWC_URL` env var.

### `wallet.getBalance(opts?)` → `{ balanceSats, balanceMsats }`
### `wallet.createInvoice(opts)` → `{ invoice, paymentHash, amountSats }`
### `wallet.payInvoice(invoice, opts?)` → `{ preimage, paymentHash }`
### `wallet.payAddress(address, opts)` → `{ preimage, paymentHash, invoice, amountSats }`
### `wallet.waitForPayment(hash, opts?)` → `{ paid, preimage, settledAt }`
### `wallet.decodeInvoice(invoice)` → `{ amountSats, network }`
### `wallet.close()`

### Standalone helpers
- `resolveLightningAddress(address, amountSats, comment?)` — Resolve without paying
- `decodeBolt11(invoice)` — Offline bolt11 decoder
- `parseNwcUrl(url)` — Parse NWC URL into components

## CLI

```bash
export NWC_URL="nostr+walletconnect://..."

lightning-agent balance
lightning-agent invoice 50 "API call fee"
lightning-agent pay lnbc50u1p...
lightning-agent decode lnbc50u1p...
lightning-agent wait <payment_hash> [timeout_ms]
```

## Getting an NWC URL

You need a Nostr Wallet Connect URL from a compatible wallet:

- **[Alby Hub](https://albyhub.com)** — Self-hosted Lightning node with NWC. Recommended.
- **[Mutiny Wallet](https://mutinywallet.com)** — Mobile-first with NWC support.
- **[Coinos](https://coinos.io)** — Web wallet with NWC.

## Design Philosophy

Built for AI agents, not humans:

- **Minimal deps** — just `nostr-tools` and `ws`
- **No UI** — pure code, any Node.js environment
- **Fresh connections** — new relay connection per request for reliability
- **Timeouts everywhere** — agents can't afford to hang
- **Composable** — auth + escrow + streaming + payments work together

## License

MIT — Built by [Jeletor](https://jeletor.com)
