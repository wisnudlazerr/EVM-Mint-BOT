const { ethers } = require("ethers");
const { loadEnv, boolValue, numberValue } = require("./env");

const CHAIN_IDS = {
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  arbitrum_one: 42161,
  optimism: 10,
  op: 10,
  polygon: 137,
  matic: 137,
  abstract: 2741,
  zora: 7777777,
  blast: 81457,
  shape: 360,
  apechain: 33139,
  worldchain: 480,
  berachain: 80094,
  bsc: 56,
  binance: 56,
  bnb: 56,
  avalanche: 43114,
  avax: 43114,
  linea: 59144,
  scroll: 534352,
  mantle: 5000,
  zksync: 324,
  zksync_era: 324,
  manta: 169,
  mode: 34443,
  opbnb: 204,
  ronin: 2020,
  sei: 1329,
  sonic: 146,
  ink: 57073,
  unichain: 130,
  sepolia: 11155111,
  base_sepolia: 84532,
  bsc_testnet: 97,
};

function parseArgs(argv = process.argv.slice(2)) {
  const set = new Set(argv);
  return {
    preflight: set.has("--preflight"),
    dryRun: set.has("--dry-run"),
  };
}

function listValue(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validIso(value) {
  if (!value) return true;
  const time = Date.parse(value);
  return Number.isFinite(time) && !Number.isNaN(time);
}

function validateConfig(config) {
  const errors = [];
  const signingRequired = !config.dryRun && !config.preflightOnly;

  if (!config.rpcUrls.length) errors.push("Missing RPC_URL in .env");
  if (!config.nftContract || !ethers.isAddress(config.nftContract))
    errors.push("Invalid NFT_CONTRACT address");
  if (!Number.isInteger(config.quantity) || config.quantity <= 0)
    errors.push("QUANTITY must be a positive integer");
  if (!Number.isFinite(config.mintPriceEth) || config.mintPriceEth < 0)
    errors.push("MINT_PRICE must be a valid non-negative number");
  if (!Number.isFinite(config.maxMintValueEth) || config.maxMintValueEth < 0)
    errors.push("MAX_MINT_VALUE_ETH must be a valid non-negative number");
  if (!validIso(config.startAt))
    errors.push("START_AT must be a valid ISO datetime");
  if (!["public", "private", "hybrid"].includes(config.broadcastRoute))
    errors.push("BROADCAST_ROUTE must be public, private, or hybrid");
  if (!CHAIN_IDS[config.chainIdentifier])
    errors.push(`Unsupported CHAIN_IDENTIFIER ${config.chainIdentifier}`);
  if (signingRequired && !config.privateKeys.length)
    errors.push("Missing PRIVATE_KEY in .env");
  if (config.privateKeys.some((key) => !/^0x[0-9a-fA-F]{64}$/.test(key)))
    errors.push("PRIVATE_KEY must be a 32-byte hex string");

  if (errors.length) {
    const err = new Error(errors.join("\n"));
    err.validationErrors = errors;
    throw err;
  }
}

function loadConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const env = loadEnv();
  const dryRun = args.dryRun || boolValue(env.DRY_RUN, true);
  const preflightOnly = args.preflight || boolValue(env.PREFLIGHT_ONLY, false);
  const chainIdentifier = String(
    env.CHAIN_IDENTIFIER || "ethereum",
  ).toLowerCase();
  const privateKeys = listValue(env.PRIVATE_KEYS || env.PRIVATE_KEY).map(
    (key) => (key.startsWith("0x") ? key : `0x${key}`),
  );

  const config = {
    env,
    dryRun,
    preflightOnly,
    chainIdentifier,
    expectedChainId: CHAIN_IDS[chainIdentifier],
    privateKeys,
    rpcUrls: listValue(env.RPC_URLS || env.RPC_URL),
    nftContract: env.NFT_CONTRACT || "",
    openseaSlug: env.OPENSEA_SLUG || "",
    quantity: Number.parseInt(env.QUANTITY || "1", 10),
    mintPriceEth: numberValue(env.MINT_PRICE, 0),
    maxMintValueEth: numberValue(env.MAX_MINT_VALUE_ETH, 0.5),
    startAt: env.START_AT || "",
    gasLimit: BigInt(Number.parseInt(env.GAS_LIMIT || "350000", 10)),
    baseFeeMultiplier: BigInt(
      Number.parseInt(env.BASE_FEE_MULTIPLIER || "300", 10),
    ),
    minPriorityGwei: numberValue(env.MIN_PRIORITY_GWEI, 2),
    maxPriorityGwei: numberValue(env.MAX_PRIORITY_GWEI, 10),
    broadcastRoute: String(env.BROADCAST_ROUTE || "public").toLowerCase(),
    privateRelayUrl: env.PRIVATE_RELAY_URL || "",
    privateRelayAuthKey: env.PRIVATE_RELAY_AUTH_KEY || "",
    logFile: env.LOG_FILE || "logs/mint-results.jsonl",
  };

  validateConfig(config);
  return config;
}

module.exports = { CHAIN_IDS, loadConfig, validateConfig, parseArgs };
