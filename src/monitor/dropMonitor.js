function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPublicDrop(
  seaDropContract,
  nftContract,
  pollIntervalMs,
  logger,
) {
  while (true) {
    try {
      const drop = await seaDropContract.getPublicDrop(nftContract);
      const now = Math.floor(Date.now() / 1000);
      const start = Number(drop.startTime || 0);
      const end = Number(drop.endTime || 0);
      if (start && now < start) {
        logger.info("public drop not started", {
          startTime: start,
          waitSeconds: start - now,
        });
        await sleep(
          Math.min(pollIntervalMs, Math.max(1000, (start - now) * 1000)),
        );
        continue;
      }
      if (end && now > end) throw new Error("Public drop already ended");
      logger.info("public drop active", { startTime: start, endTime: end });
      return drop;
    } catch (error) {
      logger.warn("public drop poll failed", {
        error: error.shortMessage || error.message,
      });
      await sleep(pollIntervalMs);
    }
  }
}

module.exports = { waitForPublicDrop };
