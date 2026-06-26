const { ethers } = require("ethers");
const { SEADROP_ABI } = require("./abi/seadrop");
const { fetchOpenSeaTransaction } = require("./opensea");

function parseJson(value, fallback, label) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`);
  }
}

function normalizeMintParams(raw) {
  const params = Array.isArray(raw)
    ? raw
    : [
        raw.mintPrice,
        raw.maxTotalMintableByWallet,
        raw.startTime,
        raw.endTime,
        raw.dropStageIndex,
        raw.maxTokenSupplyForStage,
        raw.feeBps,
        Boolean(raw.restrictFeeRecipients),
      ];

  if (params.length !== 8) {
    throw new Error(
      "MINT_PARAMS_JSON must contain 8 SeaDrop mintParams fields",
    );
  }

  return params;
}

function buildSeaDropAllowlistTx(config, wallet, feeRecipient) {
  if (!config.seadropContract)
    throw new Error("SEADROP_CONTRACT is required for allowlist mode");
  const mintParams = normalizeMintParams(
    parseJson(config.env.MINT_PARAMS_JSON, null, "MINT_PARAMS_JSON"),
  );
  const proof = parseJson(config.env.PROOF_JSON || "[]", [], "PROOF_JSON");
  const iface = new ethers.Interface(SEADROP_ABI);
  const value =
    ethers.parseEther(String(config.mintPriceEth)) * BigInt(config.quantity);
  const data = iface.encodeFunctionData("mintAllowList", [
    ethers.getAddress(config.nftContract),
    feeRecipient,
    wallet.address,
    BigInt(config.quantity),
    mintParams,
    proof,
  ]);
  return {
    to: ethers.getAddress(config.seadropContract),
    data,
    value,
    route: "seadrop-allowlist",
  };
}

function buildSeaDropSignedTx(config, wallet, feeRecipient) {
  if (!config.seadropContract)
    throw new Error("SEADROP_CONTRACT is required for signed mode");
  const mintParams = normalizeMintParams(
    parseJson(config.env.MINT_PARAMS_JSON, null, "MINT_PARAMS_JSON"),
  );
  const salt = config.env.SALT || config.env.MINT_SALT;
  const signature = config.env.SIGNATURE || config.env.MINT_SIGNATURE;
  if (!salt) throw new Error("SALT is required for signed mode");
  if (!signature) throw new Error("SIGNATURE is required for signed mode");

  const iface = new ethers.Interface(SEADROP_ABI);
  const value =
    ethers.parseEther(String(config.mintPriceEth)) * BigInt(config.quantity);
  const data = iface.encodeFunctionData("mintSigned", [
    ethers.getAddress(config.nftContract),
    feeRecipient,
    wallet.address,
    BigInt(config.quantity),
    mintParams,
    BigInt(salt),
    signature,
  ]);
  return {
    to: ethers.getAddress(config.seadropContract),
    data,
    value,
    route: "seadrop-signed",
  };
}

function buildSeaDropPublicTx(config, wallet, feeRecipient) {
  if (!config.seadropContract)
    throw new Error("SEADROP_CONTRACT is required for public mode");
  const iface = new ethers.Interface(SEADROP_ABI);
  const value =
    ethers.parseEther(String(config.mintPriceEth)) * BigInt(config.quantity);
  const data = iface.encodeFunctionData("mintPublic", [
    ethers.getAddress(config.nftContract),
    feeRecipient,
    wallet.address,
    BigInt(config.quantity),
  ]);
  return {
    to: ethers.getAddress(config.seadropContract),
    data,
    value,
    route: "seadrop-public",
  };
}

function buildDirectMintTx(config) {
  const args = parseJson(
    config.env.MINT_ARGS_JSON || `[${config.quantity}]`,
    [config.quantity],
    "MINT_ARGS_JSON",
  );
  const abi = [
    `function ${config.mintFunction}(${args.map(() => "uint256").join(",")}) payable`,
  ];
  const iface = new ethers.Interface(abi);
  const value =
    ethers.parseEther(String(config.mintPriceEth)) * BigInt(config.quantity);
  const data = iface.encodeFunctionData(
    config.mintFunction,
    args.map((arg) => BigInt(arg)),
  );
  return {
    to: ethers.getAddress(config.nftContract),
    data,
    value,
    route: `direct-${config.mintFunction}`,
  };
}

async function buildMintTx(
  config,
  wallet,
  logger,
  feeRecipient = ethers.ZeroAddress,
) {
  const openseaTx = await fetchOpenSeaTransaction(config, wallet, logger);
  if (openseaTx) return openseaTx;

  if (config.mintMode === "allowlist")
    return buildSeaDropAllowlistTx(config, wallet, feeRecipient);
  if (config.mintMode === "signed")
    return buildSeaDropSignedTx(config, wallet, feeRecipient);
  if (config.mintMode === "public")
    return buildSeaDropPublicTx(config, wallet, feeRecipient);
  return buildDirectMintTx(config, wallet);
}

function summarizeMintCost(tx, gasLimit, feePlan) {
  return {
    value: tx.value,
    gasLimit,
    maxGasCost: gasLimit * feePlan.maxFeePerGas,
    maxTotalCost: tx.value + gasLimit * feePlan.maxFeePerGas,
  };
}

module.exports = { buildMintTx, summarizeMintCost };
