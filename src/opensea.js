async function fetchOpenSeaTransaction(config, wallet, logger) {
  if (!config.openseaSlug) return null;
  logger.warn(
    "OpenSea proof fetch is not implemented in this public template",
    {
      slug: config.openseaSlug,
      wallet: wallet.address,
    },
  );
  return null;
}

module.exports = { fetchOpenSeaTransaction };
