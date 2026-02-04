'use strict';

const { finalizeEvent, getPublicKey } = require('nostr-tools');
const { Relay } = require('nostr-tools/relay');
const nip04 = require('nostr-tools/nip04');

// ─── Bolt11 minimal decoder ───

const MULTIPLIERS = {
  m: 1e-3,   // milli-BTC
  u: 1e-6,   // micro-BTC
  n: 1e-9,   // nano-BTC
  p: 1e-12   // pico-BTC
};
const BTC_TO_SATS = 1e8;

/**
 * Decode a bolt11 invoice's human-readable part to extract amount in sats.
 * Format: ln<network><amount><multiplier>
 * Examples: lnbc50u = 50 micro-BTC = 5000 sats
 *           lnbc210n = 210 nano-BTC = 21 sats
 *           lnbc1m = 1 milli-BTC = 100000 sats
 */
function decodeBolt11(invoice) {
  if (!invoice || typeof invoice !== 'string') {
    throw new Error('Invalid bolt11 invoice');
  }

  const lower = invoice.toLowerCase();

  // Find the separator: last '1' before the data part
  // The human-readable part is everything before the last '1' that's followed by data
  // Bolt11 uses bech32: <hrp>1<data><checksum>
  const lastOneIdx = lower.lastIndexOf('1');
  if (lastOneIdx < 4) throw new Error('Invalid bolt11: no separator found');

  const hrp = lower.substring(0, lastOneIdx);

  // Parse HRP: ln + network prefix + amount
  // Network prefixes: bc (mainnet), tb (testnet), bcrt (regtest), tbs (signet)
  let rest;
  if (hrp.startsWith('lnbc')) {
    rest = hrp.substring(4);
  } else if (hrp.startsWith('lntbs')) {
    rest = hrp.substring(5);
  } else if (hrp.startsWith('lntb')) {
    rest = hrp.substring(4);
  } else if (hrp.startsWith('lnbcrt')) {
    rest = hrp.substring(6);
  } else {
    throw new Error('Unknown bolt11 network prefix');
  }

  let amountSats = null;

  if (rest.length > 0) {
    // Last char might be a multiplier
    const lastChar = rest[rest.length - 1];
    if (MULTIPLIERS[lastChar] !== undefined) {
      const numStr = rest.substring(0, rest.length - 1);
      const num = parseFloat(numStr);
      if (isNaN(num)) throw new Error('Invalid bolt11 amount: ' + numStr);
      const btcAmount = num * MULTIPLIERS[lastChar];
      amountSats = Math.round(btcAmount * BTC_TO_SATS);
    } else {
      // No multiplier — amount is in BTC
      const num = parseFloat(rest);
      if (isNaN(num)) throw new Error('Invalid bolt11 amount: ' + rest);
      amountSats = Math.round(num * BTC_TO_SATS);
    }
  }
  // If rest is empty, it's a zero-amount invoice

  // Try to extract description from tagged fields (best effort)
  // Tagged fields are in the data part after the separator, bech32-decoded
  // This is complex — we do minimal extraction
  let description = null;
  let paymentHash = null;

  try {
    const dataPart = lower.substring(lastOneIdx + 1);
    // First 7 chars = timestamp (bech32 chars, 35 bits)
    // Then tagged fields follow
    // Each tag: 1 char type + 2 chars data length + data
    // We'd need full bech32 decoding for this — skip for now
    // Payment hash and description require full bech32 decode
  } catch (_) { /* best effort */ }

  return {
    amountSats,
    description,
    paymentHash,
    network: hrp.startsWith('lntbs') ? 'signet' :
             hrp.startsWith('lntb') ? 'testnet' :
             hrp.startsWith('lnbcrt') ? 'regtest' : 'mainnet'
  };
}

// ─── Lightning Address (LNURL-pay) resolver ───

/**
 * Resolve a Lightning address to a bolt11 invoice via LNURL-pay.
 * Lightning address format: user@domain → https://domain/.well-known/lnurlp/user
 * @param {string} address - Lightning address (user@domain)
 * @param {number} amountSats - Amount in satoshis
 * @param {string} [comment] - Optional payer comment
 * @returns {Promise<{ invoice: string, minSats: number, maxSats: number }>}
 */
async function resolveLightningAddress(address, amountSats, comment) {
  const [name, domain] = address.split('@');
  if (!name || !domain) throw new Error('Invalid Lightning address: ' + address);

  // Step 1: Fetch LNURL-pay metadata
  const metaUrl = `https://${domain}/.well-known/lnurlp/${name}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`LNURL fetch failed (${metaRes.status}): ${metaUrl}`);
  const meta = await metaRes.json();

  if (meta.status === 'ERROR') throw new Error('LNURL error: ' + (meta.reason || 'unknown'));
  if (!meta.callback) throw new Error('LNURL response missing callback URL');

  const minSats = Math.ceil((meta.minSendable || 1000) / 1000);
  const maxSats = Math.floor((meta.maxSendable || 100000000000) / 1000);

  if (amountSats < minSats) throw new Error(`Amount ${amountSats} below minimum ${minSats} sats`);
  if (amountSats > maxSats) throw new Error(`Amount ${amountSats} above maximum ${maxSats} sats`);

  // Step 2: Request invoice from callback
  const amountMsats = amountSats * 1000;
  const sep = meta.callback.includes('?') ? '&' : '?';
  let cbUrl = `${meta.callback}${sep}amount=${amountMsats}`;
  if (comment && meta.commentAllowed && comment.length <= meta.commentAllowed) {
    cbUrl += `&comment=${encodeURIComponent(comment)}`;
  }

  const invoiceRes = await fetch(cbUrl);
  if (!invoiceRes.ok) throw new Error(`LNURL callback failed (${invoiceRes.status})`);
  const invoiceData = await invoiceRes.json();

  if (invoiceData.status === 'ERROR') throw new Error('LNURL error: ' + (invoiceData.reason || 'unknown'));
  if (!invoiceData.pr) throw new Error('LNURL response missing invoice (pr field)');

  return {
    invoice: invoiceData.pr,
    minSats,
    maxSats
  };
}

// ─── NWC URL parser ───

function parseNwcUrl(nwcUrl) {
  if (!nwcUrl || typeof nwcUrl !== 'string') {
    throw new Error('NWC URL is required');
  }

  if (!nwcUrl.startsWith('nostr+walletconnect://')) {
    throw new Error('Invalid NWC URL: must start with nostr+walletconnect://');
  }

  const url = new URL(nwcUrl);
  const walletPubkey = url.hostname || url.pathname.replace('//', '');
  const relay = url.searchParams.get('relay');
  const secret = url.searchParams.get('secret');

  if (!walletPubkey || walletPubkey.length !== 64) {
    throw new Error('Invalid NWC URL: bad wallet pubkey');
  }
  if (!relay) {
    throw new Error('Invalid NWC URL: missing relay parameter');
  }
  if (!secret || secret.length !== 64) {
    throw new Error('Invalid NWC URL: missing or invalid secret');
  }

  return { walletPubkey, relay, secret };
}

// ─── Wallet class ───

class NWCWallet {
  constructor(nwcUrl) {
    const parsed = parseNwcUrl(nwcUrl);
    this.walletPubkey = parsed.walletPubkey;
    this.relayUrl = parsed.relay;
    this.secret = parsed.secret;
    this.secretBytes = Uint8Array.from(Buffer.from(parsed.secret, 'hex'));
    this.clientPubkey = getPublicKey(this.secretBytes);

    this._closed = false;
  }

  // ─── Core NWC request ───
  // Uses a fresh relay connection per request for reliability.
  // NWC relays (especially Alby) handle connection reuse poorly.

  async _nwcRequest(method, params = {}, timeoutMs = 15000) {
    const payload = JSON.stringify({ method, params });
    const encrypted = await nip04.encrypt(this.secretBytes, this.walletPubkey, payload);

    const event = finalizeEvent({
      kind: 23194,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', this.walletPubkey]],
      content: encrypted
    }, this.secretBytes);

    // Fresh connection per request — more reliable than reuse
    const relay = await Relay.connect(this.relayUrl);
    await relay.publish(event);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close();
        try { relay.close(); } catch (_) {}
        reject(new Error(`NWC request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const sub = relay.subscribe(
        [{ kinds: [23195], '#e': [event.id], limit: 1 }],
        {
          onevent: async (e) => {
            clearTimeout(timer);
            try {
              const decrypted = await nip04.decrypt(this.secretBytes, e.pubkey, e.content);
              const parsed = JSON.parse(decrypted);

              if (parsed.error) {
                reject(new Error(`NWC error (${parsed.error.code}): ${parsed.error.message}`));
              } else {
                resolve(parsed);
              }
            } catch (err) {
              reject(new Error('NWC decrypt failed: ' + err.message));
            }
            sub.close();
            try { relay.close(); } catch (_) {}
          }
        }
      );
    });
  }

  // ─── Public API ───

  /**
   * Get wallet balance in sats.
   */
  async getBalance(opts = {}) {
    const timeoutMs = opts.timeoutMs || 15000;
    const res = await this._nwcRequest('get_balance', {}, timeoutMs);
    // NWC returns balance in millisats
    const balanceMsats = res.result?.balance || 0;
    return {
      balanceSats: Math.round(balanceMsats / 1000),
      balanceMsats
    };
  }

  /**
   * Create a Lightning invoice (get paid).
   * @param {object} opts
   * @param {number} opts.amountSats - Amount in satoshis
   * @param {string} [opts.description] - Invoice description
   * @param {number} [opts.timeoutMs] - Request timeout
   */
  async createInvoice(opts = {}) {
    // Accept both amountSats and amount for convenience
    const sats = opts.amountSats || opts.amount;
    if (!sats || sats <= 0) {
      throw new Error('amountSats is required and must be positive');
    }

    const params = {
      amount: sats * 1000, // NWC uses millisats
    };
    if (opts.description) params.description = opts.description;
    if (opts.expiry) params.expiry = opts.expiry;

    const timeoutMs = opts.timeoutMs || 15000;
    const res = await this._nwcRequest('make_invoice', params, timeoutMs);

    return {
      invoice: res.result?.invoice,
      paymentHash: res.result?.payment_hash,
      description: res.result?.description || opts.description || null,
      amountSats: opts.amountSats
    };
  }

  /**
   * Pay a Lightning invoice.
   * @param {string} invoice - Bolt11 invoice string
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Request timeout (default 30s for payments)
   */
  async payInvoice(invoice, opts = {}) {
    if (!invoice || typeof invoice !== 'string') {
      throw new Error('invoice is required');
    }

    const timeoutMs = opts.timeoutMs || 30000; // Longer default for payments
    const res = await this._nwcRequest('pay_invoice', { invoice }, timeoutMs);

    return {
      preimage: res.result?.preimage,
      paymentHash: res.result?.payment_hash || null
    };
  }

  /**
   * Wait for an invoice to be paid by polling lookup_invoice.
   * @param {string} paymentHash - Payment hash to check
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Total wait timeout (default 60s)
   * @param {number} [opts.pollIntervalMs] - Poll interval (default 2s)
   */
  async waitForPayment(paymentHash, opts = {}) {
    if (!paymentHash) throw new Error('paymentHash is required');

    const timeoutMs = opts.timeoutMs || 60000;
    const pollIntervalMs = opts.pollIntervalMs || 2000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this._nwcRequest('lookup_invoice', { payment_hash: paymentHash }, 10000);
        // Check if settled
        if (res.result?.settled_at || res.result?.preimage) {
          return {
            paid: true,
            preimage: res.result.preimage || null,
            settledAt: res.result.settled_at || null
          };
        }
      } catch (err) {
        // lookup_invoice might not be supported — continue polling
        if (err.message.includes('NOT_IMPLEMENTED')) {
          throw new Error('lookup_invoice not supported by this wallet');
        }
        // Other errors: retry
      }

      // Wait before next poll
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return { paid: false, preimage: null, settledAt: null };
  }

  /**
   * Pay a Lightning address (LNURL-pay) like user@domain.com.
   * Resolves the address to a bolt11 invoice, then pays it.
   * @param {string} address - Lightning address (user@domain)
   * @param {object} opts
   * @param {number} opts.amountSats - Amount in satoshis (required)
   * @param {string} [opts.comment] - Optional payer comment
   * @param {number} [opts.timeoutMs] - Payment timeout
   * @returns {Promise<{ preimage, paymentHash, invoice, amountSats }>}
   */
  async payAddress(address, opts = {}) {
    if (!address || !address.includes('@')) {
      throw new Error('Invalid Lightning address: must be user@domain');
    }
    if (!opts.amountSats || opts.amountSats <= 0) {
      throw new Error('amountSats is required and must be positive');
    }

    const resolved = await resolveLightningAddress(address, opts.amountSats, opts.comment);
    const payResult = await this.payInvoice(resolved.invoice, { timeoutMs: opts.timeoutMs || 30000 });

    return {
      preimage: payResult.preimage,
      paymentHash: payResult.paymentHash,
      invoice: resolved.invoice,
      amountSats: opts.amountSats
    };
  }

  /**
   * Decode a bolt11 invoice (offline, no NWC needed).
   * @param {string} invoice - Bolt11 invoice string
   */
  decodeInvoice(invoice) {
    return decodeBolt11(invoice);
  }

  /**
   * Close the relay connection.
   */
  close() {
    this._closed = true;
  }
}

// ─── Factory function ───

function createWallet(nwcUrl) {
  const url = nwcUrl || process.env.NWC_URL;
  if (!url) {
    throw new Error('NWC URL required. Pass it directly or set NWC_URL env var.');
  }
  return new NWCWallet(url);
}

// ─── Exports ───

module.exports = {
  createWallet,
  parseNwcUrl,
  decodeBolt11,
  resolveLightningAddress,
  NWCWallet
};
