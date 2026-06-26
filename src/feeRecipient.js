const { ethers } = require("ethers");
const { SEADROP_ABI } = require("./abi/seadrop");

async function resolveFeeRecipient(config, provider, logger) {
  if (config.feeRecipient) return ethers.getAddress(config.feeRecipient);
  if (!config.seadropContract) return ethers.ZeroAddress;

  const seaDrop = new ethers.Contract(
    config.seadropContract,
    SEADROP_ABI,
    provider,
  );
  try {
    const recipients = await seaDrop.getAllowedFeeRecipients(
      config.nftContract,
    );
    if (recipients && recipients.length) {
      logger.info("fee recipient resolved from SeaDrop allowed list", {
        feeRecipient: recipients[0],
      });
      return recipients[0];
    }
  } catch (error) {
    logger.warn("getAllowedFeeRecipients failed", {
      error: error.shortMessage || error.message,
    });
  }

  try {
    const payout = await seaDrop.getCreatorPayoutAddress(config.nftContract);
    if (payout && payout !== ethers.ZeroAddress) {
      logger.info("fee recipient resolved from creator payout", {
        feeRecipient: payout,
      });
      return payout;
    }
  } catch (error) {
    logger.warn("getCreatorPayoutAddress failed", {
      error: error.shortMessage || error.message,
    });
  }

  logger.warn("fee recipient unresolved; using zero address");
  return ethers.ZeroAddress;
}

module.exports = { resolveFeeRecipient };
