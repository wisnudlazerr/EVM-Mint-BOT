async function sendPublic(wallet, tx, logger) {
  const response = await wallet.sendTransaction(tx);
  logger.info("transaction submitted", {
    hash: response.hash,
    wallet: wallet.address,
    to: tx.to,
  });
  const receipt = await response.wait();
  logger.info("transaction confirmed", {
    hash: response.hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  });
  return { response, receipt };
}

async function broadcastGasLadder(config, wallet, txs, logger) {
  const nonce = await wallet.getNonce("pending");
  const chain = await wallet.provider.getNetwork();
  const signed = [];

  for (const item of txs) {
    const tx = { ...item.tx, nonce, chainId: Number(chain.chainId), type: 2 };
    const raw = await wallet.signTransaction(tx);
    signed.push({ raw, tierPct: item.tierPct });
  }

  logger.info("broadcast same-nonce gas ladder", {
    wallet: wallet.address,
    nonce,
    tiers: signed.map((item) => item.tierPct).join(","),
  });

  const results = await Promise.allSettled(
    signed.map(async (item) => {
      const response = await wallet.provider.broadcastTransaction(item.raw);
      logger.info("tier submitted", {
        tierPct: item.tierPct,
        hash: response.hash,
      });
      return { tierPct: item.tierPct, response };
    }),
  );

  const accepted = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  for (const result of results.filter((item) => item.status === "rejected")) {
    logger.warn("tier rejected", {
      error: result.reason.shortMessage || result.reason.message,
    });
  }

  if (!accepted.length) throw new Error("All gas ladder broadcasts failed");

  const receipt = await accepted[0].response.wait();
  logger.info("ladder receipt", {
    hash: accepted[0].response.hash,
    tierPct: accepted[0].tierPct,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  });
  return { accepted, receipt };
}

module.exports = { broadcastGasLadder, sendPublic };
