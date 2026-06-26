const { ethers } = require('ethers');

function deriveWallets(privateKeys, provider) {
  return privateKeys.map((key) => new ethers.Wallet(key, provider));
}

async function getWalletSummary(wallet, provider) {
  const balance = await provider.getBalance(wallet.address);
  return { address: wallet.address, balance };
}

module.exports = { deriveWallets, getWalletSummary };
