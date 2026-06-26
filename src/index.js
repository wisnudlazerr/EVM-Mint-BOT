#!/usr/bin/env node
const { ethers } = require('ethers');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { connectRpc, contractHasCode } = require('./rpc');
const { deriveWallets } = require('./wallet');
const { buildFeePlan, estimateGas } = require('./gas');
const { buildMintTx, summarizeMintCost } = require('./mint');
const { broadcast } = require('./broadcast');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilStart(startAt, logger) {
  if (!startAt) return;
  const target = Date.parse(startAt);
  const left = target - Date.now();
  if (left <= 0) return;
  logger.info('waiting for START_AT', { startAt, waitMs: left });
  await sleep(left);
}

async function preflight(config, provider, wallets, logger) {
  const nftHasCode = await contractHasCode(provider, config.nftContract);
  if (!nftHasCode) throw new Error('NFT_CONTRACT has no code on selected chain');

  if (config.seadropContract) {
    const seadropHasCode = await contractHasCode(provider, config.seadropContract);
    if (!seadropHasCode) throw new Error('SEADROP_CONTRACT has no code on selected chain');
  }

  logger.info('preflight config ok', {
    chainIdentifier: config.chainIdentifier,
    chainId: config.expectedChainId,
    nftContract: config.nftContract,
    seadropContract: config.seadropContract || null,
    quantity: config.quantity,
    dryRun: config.dryRun,
    preflightOnly: config.preflightOnly,
  });

  if (!wallets.length) {
    logger.warn('no wallet loaded; config-only preflight complete');
    return;
  }

  for (const wallet of wallets) {
    const balance = await provider.getBalance(wallet.address);
    logger.info('wallet ok', { wallet: wallet.address, balanceEth: ethers.formatEther(balance) });
  }
}

async function run() {
  const config = loadConfig();
  const logger = createLogger({ file: config.logFile });
  const rpc = await connectRpc(config, logger);
  const provider = rpc.provider;
  const wallets = deriveWallets(config.privateKeys, provider);

  await preflight(config, provider, wallets, logger);
  if (config.preflightOnly) return;
  if (!wallets.length) throw new Error('Missing PRIVATE_KEY in .env');

  await waitUntilStart(config.startAt, logger);
  const feePlan = await buildFeePlan(provider, config);

  for (const wallet of wallets) {
    const baseTx = await buildMintTx(config, wallet, logger);
    const gasLimit = await estimateGas(provider, { from: wallet.address, ...baseTx }, config.gasLimit);
    const cost = summarizeMintCost(baseTx, gasLimit, feePlan);
    const balance = await provider.getBalance(wallet.address);

    logger.info('mint summary', {
      wallet: wallet.address,
      to: baseTx.to,
      quantity: config.quantity,
      valueEth: ethers.formatEther(cost.value),
      gasLimit: gasLimit.toString(),
      maxGasCostEth: ethers.formatEther(cost.maxGasCost),
      maxTotalCostEth: ethers.formatEther(cost.maxTotalCost),
      balanceEth: ethers.formatEther(balance),
    });

    if (balance < cost.maxTotalCost) throw new Error(`Insufficient balance for ${wallet.address}`);

    const tx = {
      ...baseTx,
      gasLimit,
      maxFeePerGas: feePlan.maxFeePerGas,
      maxPriorityFeePerGas: feePlan.maxPriorityFeePerGas,
    };

    if (config.dryRun) {
      logger.info('dry-run complete; transaction not broadcast', { wallet: wallet.address });
      continue;
    }

    await broadcast(config, wallet, tx, logger);
  }
}

run().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
