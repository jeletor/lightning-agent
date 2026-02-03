'use strict';

/**
 * Lightning escrow for agent-to-agent work.
 * 
 * Flow:
 *   1. Client and worker agree on terms (amount, deadline, verifier)
 *   2. Client funds the escrow (pays invoice to escrow wallet)
 *   3. Worker delivers work + proof
 *   4. Escrow releases payment to worker (or refunds on timeout/dispute)
 * 
 * The escrow wallet is custodial — it holds funds between funding and release.
 * This is the practical tradeoff: real escrow without hold invoices.
 * 
 * @example
 * const mgr = createEscrowManager(escrowWallet);
 * const escrow = await mgr.create({
 *   amountSats: 500,
 *   workerAddress: 'worker@getalby.com',
 *   description: 'Translate 200 words EN→ES',
 *   deadlineMs: 3600000  // 1 hour
 * });
 * // Client pays: escrow.invoice
 * await mgr.fund(escrow.id);
 * // Worker delivers...
 * await mgr.release(escrow.id);
 */

const crypto = require('crypto');

// Escrow states
const State = {
  CREATED: 'created',      // Terms defined, invoice generated, awaiting payment
  FUNDED: 'funded',        // Client paid, worker can begin
  DELIVERED: 'delivered',  // Worker submitted proof, awaiting verification
  RELEASED: 'released',    // Payment sent to worker — terminal
  REFUNDED: 'refunded',    // Payment returned to client — terminal  
  EXPIRED: 'expired',      // Deadline passed without delivery — terminal
  DISPUTED: 'disputed'     // Dispute raised, manual resolution needed
};

/**
 * Create an escrow manager backed by an NWC wallet.
 * 
 * @param {NWCWallet} wallet - Wallet that holds escrowed funds
 * @param {object} [opts]
 * @param {function} [opts.onStateChange] - Called with (escrowId, oldState, newState, escrow)
 * @param {number} [opts.defaultDeadlineMs=3600000] - Default deadline (1 hour)
 * @returns {EscrowManager}
 */
function createEscrowManager(wallet, opts = {}) {
  if (!wallet) throw new Error('Escrow wallet is required');

  const defaultDeadlineMs = opts.defaultDeadlineMs || 60 * 60 * 1000;
  const onStateChange = opts.onStateChange || null;
  const escrows = new Map();
  const timers = new Map();

  function transition(id, newState) {
    const e = escrows.get(id);
    if (!e) throw new Error('Unknown escrow: ' + id);
    const old = e.state;
    e.state = newState;
    e.updatedAt = Date.now();
    e.history.push({ from: old, to: newState, at: e.updatedAt });
    if (onStateChange) onStateChange(id, old, newState, e);
    return e;
  }

  function startDeadlineTimer(id) {
    const e = escrows.get(id);
    if (!e || !e.deadline) return;
    const remaining = e.deadline - Date.now();
    if (remaining <= 0) {
      if (e.state === State.FUNDED || e.state === State.CREATED) {
        transition(id, State.EXPIRED);
      }
      return;
    }
    const timer = setTimeout(() => {
      const current = escrows.get(id);
      if (current && (current.state === State.FUNDED || current.state === State.CREATED)) {
        transition(id, State.EXPIRED);
      }
      timers.delete(id);
    }, remaining);
    timer.unref(); // Don't keep process alive
    timers.set(id, timer);
  }

  return {
    State,

    /**
     * Create a new escrow.
     * Generates a Lightning invoice for the client to pay.
     * 
     * @param {object} config
     * @param {number} config.amountSats - Escrow amount
     * @param {string} config.workerAddress - Worker's Lightning address (user@domain)
     * @param {string} [config.workerInvoice] - Or a specific bolt11 invoice to pay on release
     * @param {string} [config.description] - Work description
     * @param {number} [config.deadlineMs] - Time until auto-expire (from creation)
     * @param {string} [config.clientPubkey] - Client identifier
     * @param {string} [config.workerPubkey] - Worker identifier
     * @param {object} [config.metadata] - Arbitrary metadata
     * @returns {Promise<Escrow>}
     */
    async create(config) {
      if (!config.amountSats || config.amountSats <= 0) {
        throw new Error('amountSats must be positive');
      }
      if (!config.workerAddress && !config.workerInvoice) {
        throw new Error('workerAddress or workerInvoice required');
      }

      const id = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const deadlineMs = config.deadlineMs || defaultDeadlineMs;

      // Create invoice for client to pay
      const inv = await wallet.createInvoice({
        amountSats: config.amountSats,
        description: `Escrow: ${config.description || id}`,
        expiry: Math.ceil(deadlineMs / 1000)
      });

      const escrow = {
        id,
        state: State.CREATED,
        amountSats: config.amountSats,
        description: config.description || null,
        workerAddress: config.workerAddress || null,
        workerInvoice: config.workerInvoice || null,
        clientPubkey: config.clientPubkey || null,
        workerPubkey: config.workerPubkey || null,
        metadata: config.metadata || {},
        invoice: inv.invoice,
        paymentHash: inv.paymentHash,
        deadline: now + deadlineMs,
        createdAt: now,
        updatedAt: now,
        fundedAt: null,
        deliveredAt: null,
        releasedAt: null,
        refundedAt: null,
        deliveryProof: null,
        releasePreimage: null,
        refundAddress: null,
        history: [{ from: null, to: State.CREATED, at: now }]
      };

      escrows.set(id, escrow);
      startDeadlineTimer(id);

      return { ...escrow };
    },

    /**
     * Mark escrow as funded (client payment received).
     * Call this after confirming the client's payment landed.
     * 
     * @param {string} id - Escrow ID
     * @param {object} [opts]
     * @param {boolean} [opts.autoDetect=true] - Poll wallet for payment confirmation
     * @param {number} [opts.timeoutMs=60000] - Payment detection timeout
     * @returns {Promise<Escrow>}
     */
    async fund(id, opts = {}) {
      const e = escrows.get(id);
      if (!e) throw new Error('Unknown escrow: ' + id);
      if (e.state !== State.CREATED) {
        throw new Error(`Cannot fund escrow in state: ${e.state}`);
      }

      const autoDetect = opts.autoDetect !== false;

      if (autoDetect && e.paymentHash) {
        // Wait for payment confirmation
        const result = await wallet.waitForPayment(e.paymentHash, {
          timeoutMs: opts.timeoutMs || 60000
        });
        if (!result.paid) {
          throw new Error('Payment not received within timeout');
        }
      }

      e.fundedAt = Date.now();
      return { ...transition(id, State.FUNDED) };
    },

    /**
     * Worker submits delivery proof.
     * 
     * @param {string} id - Escrow ID
     * @param {string|object} proof - Delivery proof (hash, URL, description, etc.)
     * @returns {Escrow}
     */
    deliver(id, proof) {
      const e = escrows.get(id);
      if (!e) throw new Error('Unknown escrow: ' + id);
      if (e.state !== State.FUNDED) {
        throw new Error(`Cannot deliver on escrow in state: ${e.state}`);
      }

      e.deliveryProof = proof;
      e.deliveredAt = Date.now();
      return { ...transition(id, State.DELIVERED) };
    },

    /**
     * Release escrowed funds to the worker.
     * Pays the worker's Lightning address or invoice.
     * 
     * @param {string} id - Escrow ID
     * @returns {Promise<Escrow>}
     */
    async release(id) {
      const e = escrows.get(id);
      if (!e) throw new Error('Unknown escrow: ' + id);
      if (e.state !== State.FUNDED && e.state !== State.DELIVERED) {
        throw new Error(`Cannot release escrow in state: ${e.state}`);
      }

      let payResult;
      if (e.workerInvoice) {
        payResult = await wallet.payInvoice(e.workerInvoice);
      } else if (e.workerAddress) {
        payResult = await wallet.payAddress(e.workerAddress, {
          amountSats: e.amountSats,
          comment: `Escrow release: ${e.description || e.id}`
        });
      } else {
        throw new Error('No worker payment destination');
      }

      e.releasePreimage = payResult.preimage;
      e.releasedAt = Date.now();

      // Cancel deadline timer
      const timer = timers.get(id);
      if (timer) { clearTimeout(timer); timers.delete(id); }

      return { ...transition(id, State.RELEASED) };
    },

    /**
     * Refund escrowed funds to the client.
     * 
     * @param {string} id - Escrow ID
     * @param {string} refundAddress - Client's Lightning address for refund
     * @param {string} [reason] - Refund reason
     * @returns {Promise<Escrow>}
     */
    async refund(id, refundAddress, reason) {
      const e = escrows.get(id);
      if (!e) throw new Error('Unknown escrow: ' + id);
      if (e.state === State.RELEASED) {
        throw new Error('Cannot refund — already released');
      }
      if (e.state === State.REFUNDED) {
        throw new Error('Already refunded');
      }

      if (refundAddress) {
        await wallet.payAddress(refundAddress, {
          amountSats: e.amountSats,
          comment: `Escrow refund: ${reason || e.id}`
        });
      }

      e.refundAddress = refundAddress;
      e.refundedAt = Date.now();
      e.metadata.refundReason = reason || 'manual';

      const timer = timers.get(id);
      if (timer) { clearTimeout(timer); timers.delete(id); }

      return { ...transition(id, State.REFUNDED) };
    },

    /**
     * Raise a dispute on an escrow.
     * 
     * @param {string} id - Escrow ID
     * @param {string} reason - Dispute reason
     * @param {string} raisedBy - 'client' or 'worker'
     * @returns {Escrow}
     */
    dispute(id, reason, raisedBy) {
      const e = escrows.get(id);
      if (!e) throw new Error('Unknown escrow: ' + id);
      if (e.state === State.RELEASED || e.state === State.REFUNDED) {
        throw new Error(`Cannot dispute — escrow already ${e.state}`);
      }

      e.metadata.dispute = { reason, raisedBy, at: Date.now() };
      return { ...transition(id, State.DISPUTED) };
    },

    /**
     * Get escrow status.
     * @param {string} id
     * @returns {Escrow|null}
     */
    get(id) {
      const e = escrows.get(id);
      return e ? { ...e } : null;
    },

    /**
     * List all escrows, optionally filtered by state.
     * @param {string} [state] - Filter by state
     * @returns {Escrow[]}
     */
    list(state) {
      const all = [...escrows.values()];
      if (state) return all.filter(e => e.state === state).map(e => ({ ...e }));
      return all.map(e => ({ ...e }));
    },

    /**
     * Cleanup — cancel all timers.
     */
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
  };
}

module.exports = { createEscrowManager, State };
