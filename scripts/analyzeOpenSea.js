#!/usr/bin/env node
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { connectRpc, contractHasCode } = require('../src/rpc');
const { resolveStage } = require('../src/opensea/stageResolver');
const { resolveFeeRecipient } = require('../src/feeRecipient');

async function main() {
  const config = loadConfig(['--preflight']);
  const logger = createLogger();
  const rpc = await connectRpc(config, logger);
  const provider = rpc.provider;

  const nftHasCode = await contractHasCode(provider, config.nftContract);
  const seadropHasCode = config.seadropContract ? await contractHasCode(provider, config.seadropContract) : false;
  const stage = await resolveStage(config, logger);
  const feeRecipient = await resolveFeeRecipient(config, provider, logger);

  const report = {
    chainIdentifier: config.chainIdentifier,
    chainId: config.expectedChainId,
    nftContract: config.nftContract,
    nftHasCode,
    seadropContract: config.seadropContract || null,
    seadropHasCode,
    openSeaCollectionSlug: config.openSeaCollectionSlug || null,
    selectedStage: stage.selected
      ? {
          name: stage.selected.name,
          type: stage.selected.stageType,
          status: stage.selected.status,
          selectedMode: stage.selected.selectedMode,
          startTime: stage.selected.startTime,
          endTime: stage.selected.endTime,
        }
      : null,
    stageCount: stage.stages.length,
    feeRecipient,
    recommendedMode: stage.selected?.selectedMode === 'PUBLIC_MINT' ? 'public' : 'opensea_raw',
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
