function summarizeMintCost(tx, gasLimit, feePlan) {
  return {
    value: tx.value,
    gasLimit,
    maxGasCost: gasLimit * feePlan.maxFeePerGas,
    maxTotalCost: tx.value + gasLimit * feePlan.maxFeePerGas,
  };
}

module.exports = { summarizeMintCost };
