#!/usr/bin/env node
const { ethers } = require('ethers');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { connectRpc } = require('../src/rpc');
const { deriveWallets } = require('../src/wallet');
const { requestOpenSeaRawTx } = require('../src/opensea/proofFetcher');

async function main() {
  const config = loadConfig(['--dry-run']);
  const logger = createLogger();
  const rpc = await connectRpc(config, logger);
  const wallets = deriveWallets(config.privateKeys, rpc.provider);
  const wallet = wallets[0] || ethers.Wallet.createRandom().connect(rpc.provider);

  const result = await requestOpenSeaRawTx(config, wallet, logger);
  const report = {
    wallet: wallet.address,
    rawTxAvailable: Boolean(result.rawTx),
    errors: result.errors || [],
    to: result.rawTx?.to || null,
    valueWei: result.rawTx?.value?.toString() || null,
    dataBytes: result.rawTx?.data ? (result.rawTx.data.length - 2) / 2 : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!result.rawTx) process.exitCode = 2;
}

main().catch((error) => { console.error(`ERROR ${error.message}`); process.exitCode = 1; });
