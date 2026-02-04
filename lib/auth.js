'use strict';

/**
 * LNURL-auth for AI agents.
 * 
 * Standard LNURL-auth (LUD-04) adapted for programmatic use.
 * Agents sign challenges with their keys (Nostr or derived).
 * 
 * Server: createAuthServer() — manages challenges, verifies signatures
 * Client: signAuth() — signs a challenge programmatically
 */

const crypto = require('crypto');

// ─── Server-side: challenge management ───

/**
 * Create an LNURL-auth server/verifier.
 * 
 * @param {object} [opts]
 * @param {number} [opts.challengeTtlMs=300000] - Challenge validity (default 5 min)
 * @param {string} [opts.callbackUrl] - Full callback URL for LNURL generation
 * @returns {AuthServer}
 * 
 * @example
 * const auth = createAuthServer({ callbackUrl: 'https://api.example.com/auth' });
 * const { k1, lnurl } = auth.createChallenge();
 * // ... client signs k1 ...
 * const ok = auth.verify(k1, sig, key);
 */
function createAuthServer(opts = {}) {
  const ttl = opts.challengeTtlMs || 5 * 60 * 1000;
  const callbackUrl = opts.callbackUrl || null;
  const challenges = new Map(); // k1 → { createdAt, used }

  return {
    /**
     * Generate a new auth challenge.
     * @returns {{ k1: string, lnurl?: string, expiresAt: number }}
     */
    createChallenge() {
      // Purge expired
      const now = Date.now();
      for (const [k, v] of challenges) {
        if (now - v.createdAt > ttl) challenges.delete(k);
      }

      const k1 = crypto.randomBytes(32).toString('hex');
      challenges.set(k1, { createdAt: now, used: false });

      const result = {
        k1,
        expiresAt: now + ttl
      };

      // Generate LNURL if callback URL provided
      if (callbackUrl) {
        const sep = callbackUrl.includes('?') ? '&' : '?';
        const fullUrl = `${callbackUrl}${sep}tag=login&k1=${k1}&action=login`;
        result.lnurl = bech32Encode('lnurl', fullUrl);
        result.callbackUrl = fullUrl;
      }

      return result;
    },

    /**
     * Verify a signed challenge.
     * 
     * @param {string} k1 - The challenge hex string
     * @param {string} sig - DER-encoded signature (hex)
     * @param {string} key - Signing public key (hex, 33 bytes compressed)
     * @returns {{ valid: boolean, pubkey?: string, error?: string }}
     */
    verify(k1, sig, key) {
      if (!k1 || !sig || !key) {
        return { valid: false, error: 'Missing k1, sig, or key' };
      }

      const challenge = challenges.get(k1);
      if (!challenge) {
        return { valid: false, error: 'Unknown or expired challenge' };
      }

      if (challenge.used) {
        return { valid: false, error: 'Challenge already used' };
      }

      if (Date.now() - challenge.createdAt > ttl) {
        challenges.delete(k1);
        return { valid: false, error: 'Challenge expired' };
      }

      try {
        const valid = verifySignature(k1, sig, key);
        if (valid) {
          challenge.used = true;
          return { valid: true, pubkey: key };
        }
        return { valid: false, error: 'Invalid signature' };
      } catch (err) {
        return { valid: false, error: err.message };
      }
    },

    /**
     * Express/Connect middleware for LNURL-auth.
     * Mount at your callback path.
     * 
     * @param {function} onAuth - Called with (pubkey, req, res) on success
     * @returns {function} HTTP request handler
     */
    middleware(onAuth) {
      return (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const k1 = url.searchParams.get('k1');
        const sig = url.searchParams.get('sig');
        const key = url.searchParams.get('key');
        const tag = url.searchParams.get('tag');

        // Initial request — return challenge
        if (!sig && !key) {
          const challenge = this.createChallenge();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tag: 'login', k1: challenge.k1, action: 'login' }));
          return;
        }

        // Verification request
        const result = this.verify(k1, sig, key);
        if (result.valid) {
          if (onAuth) onAuth(result.pubkey, req, res);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'OK' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ERROR', reason: result.error }));
        }
      };
    },

    /** Number of active (unexpired, unused) challenges */
    get activeChallenges() {
      const now = Date.now();
      let count = 0;
      for (const [, v] of challenges) {
        if (!v.used && now - v.createdAt <= ttl) count++;
      }
      return count;
    }
  };
}

// ─── Client-side: sign challenges programmatically ───

/**
 * Sign an LNURL-auth challenge with a private key.
 * 
 * Uses the native secp256k1 package (libsecp256k1 bindings) for signing,
 * which produces DER signatures accepted by all LNURL-auth implementations.
 * Falls back to @noble/curves if secp256k1 is not available.
 * 
 * @param {string} k1 - Challenge hex (32 bytes)
 * @param {string|Uint8Array} privateKey - Signing private key (hex or bytes)
 * @returns {{ sig: string, key: string }}
 * 
 * @example
 * const { sig, key } = signAuth(k1, mySecretKeyHex);
 * // Send sig + key back to the auth server
 */
function signAuth(k1, privateKey) {
  // Validate k1 is a 64-character hex string (32 bytes)
  if (typeof k1 !== 'string' || !/^[0-9a-f]{64}$/i.test(k1)) {
    throw new Error('k1 must be a 64-character hex string');
  }

  // Validate privateKey is valid hex when provided as string
  if (typeof privateKey === 'string') {
    if (!/^[0-9a-f]+$/i.test(privateKey) || privateKey.length === 0) {
      throw new Error('privateKey must be a valid hex string');
    }
  }

  const privBuf = typeof privateKey === 'string'
    ? Buffer.from(privateKey, 'hex')
    : Buffer.from(privateKey);
  const msgBuf = Buffer.from(k1, 'hex');

  // Prefer native secp256k1 (libsecp256k1 bindings) — produces DER signatures
  // accepted by all LNURL-auth server implementations
  try {
    const secp = require('secp256k1');
    const { signature } = secp.ecdsaSign(msgBuf, privBuf);
    const derSig = Buffer.from(secp.signatureExport(signature)).toString('hex');
    const pubkey = Buffer.from(secp.publicKeyCreate(privBuf, true)).toString('hex');
    return { sig: derSig, key: pubkey };
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }

  // Fallback: @noble/curves with manual DER encoding
  const secp = getSecp256k1();
  const privBytes = Uint8Array.from(privBuf);
  const compactSig = secp.sign(msgBuf, privBytes);
  const sigDer = compactToDER(compactSig);
  const pubkey = Buffer.from(secp.getPublicKey(privBytes, true)).toString('hex');

  return { sig: sigDer, key: pubkey };
}

/**
 * Complete an LNURL-auth flow programmatically.
 * Fetches the challenge URL, signs it, sends the response.
 * 
 * @param {string} lnurlOrUrl - LNURL bech32 string or direct callback URL
 * @param {string|Uint8Array} privateKey - Signing private key
 * @returns {Promise<{ success: boolean, pubkey: string, error?: string }>}
 * 
 * @example
 * const result = await authenticate('lnurl1...', mySecretKeyHex);
 * if (result.success) console.log('Authenticated as', result.pubkey);
 */
async function authenticate(lnurlOrUrl, privateKey) {
  // Decode LNURL if needed
  let url = lnurlOrUrl;
  if (lnurlOrUrl.toLowerCase().startsWith('lnurl')) {
    url = bech32Decode(lnurlOrUrl);
  }

  // Parse URL to extract k1
  const parsed = new URL(url);
  const k1 = parsed.searchParams.get('k1');
  if (!k1) throw new Error('No k1 challenge in URL');

  // Sign the challenge
  const { sig, key } = signAuth(k1, privateKey);

  // Send the signed response back
  parsed.searchParams.set('sig', sig);
  parsed.searchParams.set('key', key);

  const res = await fetch(parsed.toString());
  const data = await res.json();

  if (data.status === 'OK') {
    return { success: true, pubkey: key };
  } else {
    return { success: false, pubkey: key, error: data.reason || 'Auth failed' };
  }
}

// ─── Helpers ───

// Get secp256k1 from nostr-tools dependency chain
function getSecp256k1() {
  // @noble/curves v2+ uses .js extension in exports
  try { return require('@noble/curves/secp256k1.js').secp256k1; } catch {}
  try { return require('@noble/curves/secp256k1').secp256k1; } catch {}
  try { return require('@noble/secp256k1'); } catch {}
  throw new Error('secp256k1 not available — install @noble/curves or nostr-tools');
}

// Verify a secp256k1 DER signature over a message
function verifySignature(k1Hex, sigHex, pubkeyHex) {
  const msg = Buffer.from(k1Hex, 'hex');
  const sigBuf = Buffer.from(sigHex, 'hex');
  const pub = Buffer.from(pubkeyHex, 'hex');

  // Prefer native secp256k1
  try {
    const secp = require('secp256k1');
    const compact = secp.signatureImport(sigBuf);
    return secp.ecdsaVerify(compact, msg, pub);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }

  // Fallback: @noble/curves
  const secp = getSecp256k1();
  const compactSig = derToCompact(sigHex);
  return secp.verify(compactSig, Uint8Array.from(msg), Uint8Array.from(pub));
}

// Convert 64-byte compact signature (r||s) to DER hex
function compactToDER(compact) {
  const r = Buffer.from(compact.slice(0, 32));
  const s = Buffer.from(compact.slice(32, 64));

  function encodeInt(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    buf = buf.slice(i);
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return buf;
  }

  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const body = Buffer.concat([
    Buffer.from([0x02, rEnc.length]), rEnc,
    Buffer.from([0x02, sEnc.length]), sEnc
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('hex');
}

// Convert DER hex signature to 64-byte compact (r||s)
function derToCompact(derHex) {
  const buf = Buffer.from(derHex, 'hex');
  if (buf[0] !== 0x30) throw new Error('Invalid DER: missing sequence tag');

  let offset = 2; // skip 0x30 + length byte
  if (buf[1] > 127) offset++; // handle extended length (rare)

  if (buf[offset] !== 0x02) throw new Error('Invalid DER: missing integer tag for r');
  const rLen = buf[offset + 1];
  offset += 2;
  let r = buf.slice(offset, offset + rLen);
  offset += rLen;

  if (buf[offset] !== 0x02) throw new Error('Invalid DER: missing integer tag for s');
  const sLen = buf[offset + 1];
  offset += 2;
  let s = buf.slice(offset, offset + sLen);

  // Strip leading zeros and pad to 32 bytes
  if (r[0] === 0 && r.length > 32) r = r.slice(1);
  if (s[0] === 0 && s.length > 32) s = s.slice(1);

  const rPad = Buffer.alloc(32); r.copy(rPad, 32 - r.length);
  const sPad = Buffer.alloc(32); s.copy(sPad, 32 - s.length);

  return Uint8Array.from(Buffer.concat([rPad, sPad]));
}

// Minimal bech32 encode (for LNURL generation)
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Encode(prefix, data) {
  const bytes = Buffer.from(data, 'utf8');
  const words = toWords(bytes);
  const checksum = bech32Checksum(prefix, words);
  return prefix + '1' + [...words, ...checksum].map(w => BECH32_ALPHABET[w]).join('');
}

function bech32Decode(str) {
  const lower = str.toLowerCase();
  const sepIdx = lower.lastIndexOf('1');
  const data = lower.slice(sepIdx + 1);
  const words = [];
  for (let i = 0; i < data.length - 6; i++) {
    words.push(BECH32_ALPHABET.indexOf(data[i]));
  }
  const bytes = fromWords(words);
  return Buffer.from(bytes).toString('utf8');
}

function toWords(bytes) {
  const words = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

function fromWords(words) {
  const bytes = [];
  let acc = 0, bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  return bytes;
}

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32Checksum(prefix, words) {
  const prefixExpanded = [];
  for (const c of prefix) {
    prefixExpanded.push(c.charCodeAt(0) >> 5);
  }
  prefixExpanded.push(0);
  for (const c of prefix) {
    prefixExpanded.push(c.charCodeAt(0) & 31);
  }
  const values = [...prefixExpanded, ...words, 0, 0, 0, 0, 0, 0];
  const poly = bech32Polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((poly >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

module.exports = {
  createAuthServer,
  signAuth,
  authenticate
};
