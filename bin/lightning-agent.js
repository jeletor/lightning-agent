#!/usr/bin/env node
'use strict';

const { createWallet, decodeBolt11 } = require('../lib');

const USAGE = `
lightning-agent — Lightning payments for AI agents

Usage:
  lightning-agent balance                        Check wallet balance
  lightning-agent invoice <sats> [description]   Create an invoice
  lightning-agent pay <bolt11>                   Pay an invoice
  lightning-agent decode <bolt11>                Decode an invoice (offline)
  lightning-agent wait <payment_hash> [timeout]  Wait for payment

Environment:
  NWC_URL   Nostr Wallet Connect URL (nostr+walletconnect://...)

Examples:
  export NWC_URL="nostr+walletconnect://..."
  lightning-agent balance
  lightning-agent invoice 50 "AI query fee"
  lightning-agent pay lnbc50u1p...
  lightning-agent decode lnbc50u1p...
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // decode is offline — no wallet needed
  if (command === 'decode') {
    const invoice = args[1];
    if (!invoice) {
      console.error('Error: bolt11 invoice required');
      process.exit(1);
    }
    try {
      const details = decodeBolt11(invoice);
      console.log(JSON.stringify(details, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  // All other commands need a wallet
  if (!process.env.NWC_URL) {
    console.error('Error: NWC_URL environment variable not set');
    console.error('Set it: export NWC_URL="nostr+walletconnect://..."');
    process.exit(1);
  }

  let wallet;
  try {
    wallet = createWallet(process.env.NWC_URL);
  } catch (err) {
    console.error('Error creating wallet:', err.message);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'balance': {
        const { balanceSats } = await wallet.getBalance();
        console.log(`${balanceSats} sats`);
        break;
      }

      case 'invoice': {
        const sats = parseInt(args[1], 10);
        if (!sats || sats <= 0) {
          console.error('Error: amount in sats required (positive integer)');
          process.exit(1);
        }
        const description = args.slice(2).join(' ') || undefined;
        const result = await wallet.createInvoice({ amountSats: sats, description });
        console.log(result.invoice);
        if (result.paymentHash) {
          console.error(`Payment hash: ${result.paymentHash}`);
        }
        break;
      }

      case 'pay': {
        const invoice = args[1];
        if (!invoice) {
          console.error('Error: bolt11 invoice required');
          process.exit(1);
        }
        const result = await wallet.payInvoice(invoice);
        console.log(`Paid! Preimage: ${result.preimage}`);
        break;
      }

      case 'wait': {
        const paymentHash = args[1];
        if (!paymentHash) {
          console.error('Error: payment_hash required');
          process.exit(1);
        }
        const timeoutMs = parseInt(args[2], 10) || 60000;
        console.error(`Waiting for payment (timeout: ${timeoutMs}ms)...`);
        const result = await wallet.waitForPayment(paymentHash, { timeoutMs });
        if (result.paid) {
          console.log(`Paid! Preimage: ${result.preimage}`);
        } else {
          console.log('Not paid (timed out)');
          process.exit(1);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    wallet.close();
  }
}

main();
