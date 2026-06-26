const { ethers } = require("ethers");
const { SEADROP_ABI } = require("./abi/seadrop");
const { fetchOpenSeaTransaction } = require("./opensea");

function buildManualMintTx(config, wallet) {
  const value =
    ethers.parseEther(String(config.mintPriceEth)) * BigInt(config.quantity);
  const iface = new ethers.Interface(SEADROP_ABI);

  if (config.seadropContract) {
    const data = iface.encodeFunctionData("mintPublic", [
      ethers.getAddress(config.nftContract),
      ethers.ZeroAddress,
      wallet.address,
      BigInt(config.quantity),
    ]);
    return { to: ethers.getAddress(config.seadropContract), data, value };
  }

  const data = new ethers.Interface([
    "function mint(uint256 quantity) payable",
  ]).encodeFunctionData("mint", [BigInt(config.quantity)]);
  return { to: ethers.getAddress(config.nftContract), data, value };
}

async function buildMintTx(config, wallet, logger) {
  const openseaTx = await fetchOpenSeaTransaction(config, wallet, logger);
  if (openseaTx) return openseaTx;
  return buildManualMintTx(config, wallet);
}

function summarizeMintCost(tx, gasLimit, feePlan) {
  return {
    value: tx.value,
    gasLimit,
    maxGasCost: gasLimit * feePlan.maxFeePerGas,
    maxTotalCost: tx.value + gasLimit * feePlan.maxFeePerGas,
  };
}

module.exports = { buildMintTx, buildManualMintTx, summarizeMintCost };
