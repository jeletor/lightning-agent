'use strict';

/**
 * Streaming sats — pay-per-token Lightning micropayments.
 * 
 * Provider: generates content, gates delivery on payment, emits micro-invoices.
 * Client: receives content, auto-pays invoices to keep the stream alive.
 * 
 * This is what Lightning was designed for: payments too small for any other system.
 * 
 * Transport: HTTP Server-Sent Events (SSE). Provider streams content + invoices,
 * client POSTs preimages to prove payment and unlock the next batch.
 * 
 * @example
 * // Provider side
 * const provider = createStreamProvider(wallet, {
 *   satsPerBatch: 2,
 *   tokensPerBatch: 100,
 *   maxBatches: 50
 * });
 * 
 * // In HTTP handler:
 * provider.handleRequest(req, res, async function* () {
 *   for await (const token of generateTokens(prompt)) {
 *     yield token;
 *   }
 * });
 * 
 * // Client side
 * const client = createStreamClient(wallet);
 * const stream = await client.stream('https://api.example.com/generate', {
 *   body: { prompt: 'Hello' },
 *   maxSats: 100
 * });
 * for await (const chunk of stream) {
 *   process.stdout.write(chunk);
 * }
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

// ─── Stream Provider (server side) ───

/**
 * Create a streaming payment provider.
 * 
 * @param {NWCWallet} wallet - Provider's wallet for invoice generation
 * @param {object} [opts]
 * @param {number} [opts.satsPerBatch=1] - Sats charged per batch
 * @param {number} [opts.tokensPerBatch=50] - Tokens per batch before next invoice
 * @param {number} [opts.maxBatches=100] - Maximum batches per stream
 * @param {number} [opts.paymentTimeoutMs=30000] - Time to wait for payment per batch
 * @param {number} [opts.invoiceExpiryS=120] - Invoice expiry in seconds
 * @returns {StreamProvider}
 */
function createStreamProvider(wallet, opts = {}) {
  const satsPerBatch = opts.satsPerBatch || 1;
  const tokensPerBatch = opts.tokensPerBatch || 50;
  const maxBatches = opts.maxBatches || 100;
  const paymentTimeoutMs = opts.paymentTimeoutMs || 30000;
  const invoiceExpiryS = opts.invoiceExpiryS || 120;
  const sessions = new Map();

  return {
    /**
     * Handle a streaming request over HTTP SSE.
     * 
     * Protocol:
     *   Server sends SSE events:
     *     - event: content   data: { tokens: "...", batchIndex: N }
     *     - event: invoice   data: { invoice: "lnbc...", paymentHash: "...", batchIndex: N, sats: N }
     *     - event: done      data: { totalBatches: N, totalSats: N, totalTokens: N }
     *     - event: error     data: { message: "..." }
     *   
     *   Client proves payment by POSTing to the same URL:
     *     { sessionId, preimage }
     * 
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @param {AsyncGenerator|function} generator - Async generator yielding tokens/strings
     * @param {object} [streamOpts]
     * @param {number} [streamOpts.firstBatchFree=true] - First batch free (preview)
     */
    async handleRequest(req, res, generator, streamOpts = {}) {
      const firstBatchFree = streamOpts.firstBatchFree !== false;

      // Handle payment proof POST
      if (req.method === 'POST') {
        return this._handlePayment(req, res);
      }

      // SSE setup
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const sessionId = crypto.randomBytes(16).toString('hex');
      const session = {
        id: sessionId,
        batchIndex: 0,
        totalTokens: 0,
        totalSats: 0,
        pendingPayment: null,
        paid: new Set(),
        closed: false
      };
      sessions.set(sessionId, session);

      // Send session ID
      sendSSE(res, 'session', { sessionId });

      try {
        const gen = typeof generator === 'function' ? generator() : generator;
        let buffer = '';
        let tokenCount = 0;

        for await (const token of gen) {
          if (session.closed) break;

          buffer += token;
          tokenCount++;

          // Batch full — flush and gate
          if (tokenCount >= tokensPerBatch) {
            session.batchIndex++;
            session.totalTokens += tokenCount;

            // Send content
            sendSSE(res, 'content', {
              tokens: buffer,
              batchIndex: session.batchIndex,
              tokenCount
            });

            buffer = '';
            tokenCount = 0;

            // Check if we've hit max batches
            if (session.batchIndex >= maxBatches) {
              sendSSE(res, 'done', {
                reason: 'max_batches',
                totalBatches: session.batchIndex,
                totalSats: session.totalSats,
                totalTokens: session.totalTokens
              });
              break;
            }

            // Gate: require payment for next batch (skip for first if free)
            const needsPayment = !(firstBatchFree && session.batchIndex === 1);
            if (needsPayment) {
              const invoice = await wallet.createInvoice({
                amountSats: satsPerBatch,
                description: `Stream batch ${session.batchIndex + 1}`,
                expiry: invoiceExpiryS
              });

              session.pendingPayment = {
                paymentHash: invoice.paymentHash,
                batchIndex: session.batchIndex + 1,
                invoice: invoice.invoice
              };

              sendSSE(res, 'invoice', {
                invoice: invoice.invoice,
                paymentHash: invoice.paymentHash,
                batchIndex: session.batchIndex + 1,
                sats: satsPerBatch
              });

              // Wait for payment
              const paid = await this._waitForPayment(session, paymentTimeoutMs);
              if (!paid) {
                sendSSE(res, 'paused', {
                  reason: 'payment_timeout',
                  batchIndex: session.batchIndex,
                  totalSats: session.totalSats,
                  resume: `POST with { sessionId: "${sessionId}", preimage: "..." }`
                });
                // Don't end — client can still pay and we'll resume
                // But stop generating for now
                break;
              }
              session.totalSats += satsPerBatch;
            }
          }
        }

        // Flush remaining
        if (buffer.length > 0 && !session.closed) {
          session.batchIndex++;
          session.totalTokens += tokenCount;
          sendSSE(res, 'content', {
            tokens: buffer,
            batchIndex: session.batchIndex,
            tokenCount
          });
        }

        if (!session.closed) {
          sendSSE(res, 'done', {
            reason: 'complete',
            totalBatches: session.batchIndex,
            totalSats: session.totalSats,
            totalTokens: session.totalTokens
          });
        }

      } catch (err) {
        sendSSE(res, 'error', { message: err.message });
      } finally {
        session.closed = true;
        res.end();
        // Cleanup after a delay (allow late payments)
        setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
      }
    },

    /**
     * Handle payment proof POST.
     * @private
     */
    _handlePayment(req, res) {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const session = sessions.get(data.sessionId);
            if (!session) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unknown session' }));
              return resolve();
            }

            if (data.preimage && session.pendingPayment) {
              // Verify preimage matches payment hash
              const hash = crypto.createHash('sha256')
                .update(Buffer.from(data.preimage, 'hex'))
                .digest('hex');
              
              if (hash === session.pendingPayment.paymentHash) {
                session.paid.add(session.pendingPayment.batchIndex);
                session.pendingPayment = null;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', batchUnlocked: true }));
              } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid preimage' }));
              }
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No pending payment or missing preimage' }));
            }
            resolve();
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            resolve();
          }
        });
      });
    },

    /**
     * Wait for a payment to be confirmed (via preimage POST or wallet polling).
     * @private
     */
    async _waitForPayment(session, timeoutMs) {
      if (!session.pendingPayment) return true;

      const start = Date.now();
      const hash = session.pendingPayment.paymentHash;
      const batchIdx = session.pendingPayment.batchIndex;

      // Poll: check if preimage was POSTed, or check wallet
      while (Date.now() - start < timeoutMs) {
        // Check if client POSTed the preimage
        if (session.paid.has(batchIdx)) {
          return true;
        }

        // Also check wallet directly
        try {
          const result = await wallet.waitForPayment(hash, {
            timeoutMs: 3000,
            pollIntervalMs: 1000
          });
          if (result.paid) {
            session.paid.add(batchIdx);
            session.pendingPayment = null;
            return true;
          }
        } catch {
          // Not supported or timeout — keep polling preimage POST
        }

        await new Promise(r => setTimeout(r, 1000));
      }

      return false;
    },

    /** Active session count */
    get activeSessions() {
      return [...sessions.values()].filter(s => !s.closed).length;
    }
  };
}

// ─── Stream Client (consumer side) ───

/**
 * Create a streaming payment client.
 * 
 * @param {NWCWallet} wallet - Client's wallet for paying invoices
 * @param {object} [opts]
 * @param {number} [opts.maxSats=1000] - Maximum sats to spend per stream
 * @param {boolean} [opts.autoPay=true] - Automatically pay invoices
 * @returns {StreamClient}
 */
function createStreamClient(wallet, opts = {}) {
  const maxSats = opts.maxSats || 1000;
  const autoPay = opts.autoPay !== false;

  return {
    /**
     * Open a streaming connection and iterate over content.
     * Auto-pays invoices as they arrive (within maxSats budget).
     * 
     * @param {string} url - Provider's streaming endpoint
     * @param {object} [reqOpts]
     * @param {object} [reqOpts.body] - Request body (sent as JSON)
     * @param {object} [reqOpts.headers] - Additional headers
     * @param {number} [reqOpts.maxSats] - Override max sats for this stream
     * @returns {AsyncGenerator<string>} - Yields content chunks
     * 
     * @example
     * const client = createStreamClient(wallet, { maxSats: 500 });
     * for await (const text of client.stream('https://api.example.com/stream', {
     *   body: { prompt: 'Explain Lightning Network' }
     * })) {
     *   process.stdout.write(text);
     * }
     */
    async *stream(url, reqOpts = {}) {
      const budget = reqOpts.maxSats || maxSats;
      let spent = 0;
      let sessionId = null;

      // Open SSE connection
      const headers = {
        'Accept': 'text/event-stream',
        ...(reqOpts.headers || {})
      };

      // If body provided, make initial POST to get stream URL, then GET SSE
      // For simplicity, we support GET with query params or POST that returns SSE
      const fetchOpts = { headers };
      if (reqOpts.body) {
        fetchOpts.method = 'POST';
        fetchOpts.headers['Content-Type'] = 'application/json';
        fetchOpts.body = JSON.stringify(reqOpts.body);
      }

      const response = await fetch(url, fetchOpts);
      if (!response.ok) {
        throw new Error(`Stream request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete line

          let eventType = null;
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            } else if (line === '' && eventType && eventData) {
              // Process complete event
              const data = JSON.parse(eventData);

              switch (eventType) {
                case 'session':
                  sessionId = data.sessionId;
                  break;

                case 'content':
                  yield data.tokens;
                  break;

                case 'invoice':
                  if (autoPay && spent + data.sats <= budget) {
                    try {
                      const payResult = await wallet.payInvoice(data.invoice);
                      spent += data.sats;

                      // POST preimage back to provider
                      if (sessionId && payResult.preimage) {
                        try {
                          const proofRes = await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              sessionId,
                              preimage: payResult.preimage
                            })
                          });
                          if (!proofRes.ok) {
                            console.error('Preimage POST failed:', proofRes.status);
                          }
                        } catch (postErr) {
                          console.error('Preimage POST error:', postErr.message);
                        }
                      }
                    } catch (err) {
                      // Payment failed — stream will pause
                      console.error('Stream payment failed:', err.message);
                    }
                  } else {
                    // Budget exceeded — stop paying
                    console.warn(`Stream budget exhausted (${spent}/${budget} sats)`);
                  }
                  break;

                case 'done':
                  return; // Stream complete

                case 'error':
                  throw new Error(data.message || 'Stream error');

                case 'paused':
                  // Stream paused for payment — will resume if we pay
                  break;
              }

              eventType = null;
              eventData = '';
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    /**
     * Get spending stats for a completed stream.
     */
    get budget() {
      return { maxSats };
    }
  };
}

// ─── Helpers ───

function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = {
  createStreamProvider,
  createStreamClient
};
