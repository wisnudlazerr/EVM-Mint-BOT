const { fetchOpenSeaRawTx } = require("./opensea/proofFetcher");

async function fetchOpenSeaTransaction(config, wallet, logger) {
  if (config.mintMode !== "opensea_raw") return null;
  return fetchOpenSeaRawTx(config, wallet, logger);
}

module.exports = { fetchOpenSeaTransaction };
