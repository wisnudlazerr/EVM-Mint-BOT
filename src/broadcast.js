async function sendPublic(wallet, tx, logger) {
  const response = await wallet.sendTransaction(tx);
  logger.info('transaction submitted', { hash: response.hash, wallet: wallet.address, to: tx.to });
  const receipt = await response.wait();
  logger.info('transaction confirmed', { hash: response.hash, status: receipt.status, blockNumber: receipt.blockNumber });
  return { response, receipt };
}

async function sendPrivate(config) {
  if (!config.privateRelayUrl) throw new Error('PRIVATE_RELAY_URL is required for private broadcast');
  throw new Error('Private relay broadcast is intentionally stubbed in this public template');
}

async function broadcast(config, wallet, tx, logger) {
  if (config.broadcastRoute === 'private') return sendPrivate(config, wallet, tx, logger);
  if (config.broadcastRoute === 'hybrid') {
    logger.warn('hybrid route requested; using public route because private relay is stubbed');
  }
  return sendPublic(wallet, tx, logger);
}

module.exports = { broadcast, sendPublic, sendPrivate };
