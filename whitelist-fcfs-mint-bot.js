#!/usr/bin/env node
/**
 * FCFS WHITELIST MINT BOT TEMPLATE — MODE GEBER
 * 
 * Generic template for over-allocated OpenSea allowlist mints (FCFS race among WL holders).
 * 
 * Patches:
 * [1] Parallel pre-arm (all wallets simultaneously)
 * [2] Cached proof fallback (re-use OpenSea txData if GraphQL dies mid-run)
 * [3] Triple-fire per wallet (3 gas tiers, same nonce)
 * [4] Nonce fetch right before fire (not during pre-arm)
 * [5] Supply check before fire + quantity adjustment
 * [6] Aggressive gas (300%+ base fee)
 * [7] Block timestamp sync (fire based on chain time)
 * [8] Pre-arm window configurable (default 90s before start)
 * [9] Balance check pre-fire (skip underfunded wallets)
 * [10] Replacement bump loop post-fire (escalating gas if pending)
 * [11] Private relay hooks (eth_sendPrivateTransaction / eth_sendBundle)
 * [12] Extended chain map + route selector (public/private/hybrid)
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// ─── ENV ──────────────────────────────────────────────────────────────────────
function loadEnv(file = '.env') {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const env = { ...process.env, ...loadEnv(process.env.DOTENV_PATH || '.env') };
const argv = new Set(process.argv.slice(2));
const preflightOnly = argv.has('--preflight');
const dryRun = argv.has('--dry-run') || /^(1|true|yes)$/i.test(env.DRY_RUN || '');

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function req(name) { if (!env[name]) throw new Error(`Missing ${name} in .env`); return env[name]; }
function bool(name, def = false) { return env[name] == null || env[name] === '' ? def : /^(1|true|yes)$/i.test(env[name]); }
function int(name, def) { return env[name] ? Number(env[name]) : def; }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function shortAddr(a) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
function maskUrl(url) { return url.replace(/\/v2\/.+$/, '/v2/***').replace(/\/v3\/.+$/, '/v3/***').replace(/\.pro\/.+$/, '.pro/***').replace(/key=[^&]+/i, 'key=***'); }
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadPrivateKeys() { return (env.PRIVATE_KEYS || env.PRIVATE_KEY || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean).map(k => k.startsWith('0x') ? k : '0x' + k); }

const CHAIN_IDS = {
  ethereum: 1, mainnet: 1,
  base: 8453,
  arbitrum: 42161, arbitrum_one: 42161,
  optimism: 10, op: 10,
  polygon: 137, matic: 137,
  abstract: 2741,
  zora: 7777777,
  blast: 81457,
  shape: 360,
  apechain: 33139,
  worldchain: 480,
  berachain: 80094,
  bsc: 56, binance: 56, bnb: 56,
  avalanche: 43114, avax: 43114,
  linea: 59144,
  scroll: 534352,
  mantle: 5000,
  zksync: 324, zksync_era: 324,
  manta: 169,
  mode: 34443,
  opbnb: 204,
  ronin: 2020,
  sei: 1329,
  sonic: 146,
  ink: 57073,
  unichain: 130,
  sepolia: 11155111, base_sepolia: 84532, bsc_testnet: 97
};
const chainIdentifier = (env.CHAIN_IDENTIFIER || 'ethereum').toLowerCase();
function chainIdFor(id = chainIdentifier) { const c = CHAIN_IDS[id]; if (!c) throw new Error(`Unsupported chain ${id}`); return c; }
function listEnv(name) { return (env[name] || '').split(',').map(s => s.trim()).filter(Boolean); }
function gwei(n) { return ethers.parseUnits(String(n), 'gwei'); }
function pctBump(x, pct) { return x * BigInt(pct) / 100n; }
function clampWei(x, min, max = null) {
  let y = x < min ? min : x;
  if (max != null && y > max) y = max;
  return y;
}

async function getPriorityFee(provider) {
  const envPrio = env.PRIORITY_GWEI || env.MIN_PRIORITY_GWEI;
  const minPrio = gwei(env.MIN_PRIORITY_GWEI || env.PRIORITY_GWEI || 5);
  const maxPrio = env.MAX_PRIORITY_GWEI ? gwei(env.MAX_PRIORITY_GWEI) : null;
  if (envPrio) return clampWei(gwei(envPrio), minPrio, maxPrio);
  try {
    const rpcPrio = BigInt(await provider.send('eth_maxPriorityFeePerGas', []));
    return clampWei(rpcPrio, minPrio, maxPrio);
  } catch {
    const fee = await provider.getFeeData();
    return clampWei(fee.maxPriorityFeePerGas || minPrio, minPrio, maxPrio);
  }
}

async function getBaseFee(provider) {
  try {
    const block = await provider.getBlock('pending');
    if (block?.baseFeePerGas) return block.baseFeePerGas;
  } catch {}
  const fee = await provider.getFeeData();
  return fee.lastBaseFeePerGas || fee.gasPrice || gwei(30);
}

async function buildFeePlan(provider, label = 'fire') {
  const baseFee = await getBaseFee(provider);
  const priority = await getPriorityFee(provider);
  const baseMult = BigInt(int('BASE_FEE_MULTIPLIER', int('GAS_MULTIPLIER', 300)));
  const priorityMult = BigInt(int('PRIORITY_MULTIPLIER', 100));
  const maxFeeFloor = env.MIN_MAX_FEE_GWEI ? gwei(env.MIN_MAX_FEE_GWEI) : 0n;
  const maxFeeCap = env.MAX_MAX_FEE_GWEI ? gwei(env.MAX_MAX_FEE_GWEI) : null;
  let maxPriorityFeePerGas = priority * priorityMult / 100n;
  if (env.MAX_PRIORITY_GWEI) maxPriorityFeePerGas = clampWei(maxPriorityFeePerGas, 0n, gwei(env.MAX_PRIORITY_GWEI));
  let maxFeePerGas = (baseFee * baseMult / 100n) + maxPriorityFeePerGas;
  maxFeePerGas = clampWei(maxFeePerGas, maxFeeFloor, maxFeeCap);
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  console.log(`[${nowIso()}] feePlan(${label}): base=${ethers.formatUnits(baseFee,'gwei')}gwei maxFee=${ethers.formatUnits(maxFeePerGas,'gwei')}gwei priority=${ethers.formatUnits(maxPriorityFeePerGas,'gwei')}gwei baseMult=${baseMult}% prioMult=${priorityMult}%`);
  return { baseFee, maxFeePerGas, maxPriorityFeePerGas };
}

async function estimateGasLimit(provider, wallet, txData, fallbackGasLimit) {
  if (!bool('ESTIMATE_GAS_AT_FIRE', true)) return fallbackGasLimit;
  try {
    const est = await provider.estimateGas({
      from: wallet.address,
      to: ethers.getAddress(txData.to),
      data: txData.data,
      value: txData.value
    });
    const buffer = BigInt(int('GAS_LIMIT_BUFFER_PCT', 130));
    const minGas = BigInt(int('MIN_GAS_LIMIT', Number(fallbackGasLimit)));
    const maxGas = BigInt(int('MAX_GAS_LIMIT', 900000));
    const gas = clampWei(est * buffer / 100n, minGas, maxGas);
    console.log(`[${nowIso()}] gasEstimate ${shortAddr(wallet.address)} est=${est} buffered=${gas}`);
    return gas;
  } catch (e) {
    console.log(`[${nowIso()}] gasEstimate failed ${shortAddr(wallet.address)}: ${(e.shortMessage || e.message).slice(0,120)}; fallback=${fallbackGasLimit}`);
    return fallbackGasLimit;
  }
}

async function decodeAndLogMintCalldata(iface, txData, walletAddress) {
  try {
    const parsed = iface.parseTransaction({ data: txData.data, value: txData.value });
    const names = (parsed.fragment?.inputs || []).map(x => x.name);
    const argMap = {};
    names.forEach((name, i) => { if (name) argMap[name] = parsed.args[i]; });
    console.log(`[${nowIso()}] calldata ${shortAddr(walletAddress)} fn=${parsed.name} value=${ethers.formatEther(txData.value)} args=${Object.keys(argMap).join(',')}`);
    return { name: parsed.name, argMap };
  } catch (e) {
    console.log(`[${nowIso()}] calldata decode failed ${shortAddr(walletAddress)}: ${e.message.slice(0,120)}`);
    return null;
  }
}

async function sleepUntil(tsMs) {
  while (true) {
    const left = tsMs - Date.now();
    if (left <= 0) return;
    if (left > 1000) await sleep(Math.min(1000, left - 500));
    else if (left > 80) await sleep(Math.max(10, left - 50));
    else { while (Date.now() < tsMs) {} return; }
  }
}

const LOG_FILE = env.LOG_FILE || 'fcfs-whitelist-results.jsonl';
function logEvent(event) {
  const row = { ts: nowIso(), ...event };
  ensureDir(LOG_FILE);
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
}

// ─── ABI ──────────────────────────────────────────────────────────────────────
const SEA_ABI = [
  // mintPublic kept for ABI parsing validation only (not used for allowlist)
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  'function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,bytes32[] proof) payable',
  'function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable',
  'function getMintStats(address nftContract,address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getCreatorPayoutAddress(address nftContract) view returns (address)'
];

// ─── RPC SETUP ────────────────────────────────────────────────────────────────
async function makeProvider() {
  const urls = (env.RPC_URLS || env.RPC_URL || 'https://ethereum-rpc.publicnode.com').split(',').map(s => s.trim()).filter(Boolean);
  const working = [];
  await Promise.all(urls.map(async url => {
    const provider = new ethers.JsonRpcProvider(url);
    const t = Date.now();
    try {
      await provider.getBlockNumber();
      const latency = Date.now() - t;
      console.log(`rpc ok ${latency}ms ${maskUrl(url)}`);
      working.push({ provider, latency, url });
    } catch (e) {
      console.log(`rpc failed ${maskUrl(url)}: ${e.shortMessage || e.message}`);
    }
  }));
  working.sort((a, b) => a.latency - b.latency);
  if (!working.length) throw new Error('No working RPC');
  console.log(`using fastest rpc (${working[0].latency}ms); fanout=${working.length}`);
  return { provider: working[0].provider, providers: working };
}

// ─── OPENSEA GRAPHQL ──────────────────────────────────────────────────────────
function buildVars(address, nft, quantity, slug) {
  return {
    address,
    fromAssets: [{ asset: { contractAddress: ethers.ZeroAddress, chain: chainIdentifier } }],
    toAssets: [{ asset: { contractAddress: ethers.getAddress(nft), chain: chainIdentifier, tokenId: '0' }, quantity: String(quantity) }],
    recipient: null,
    capabilities: { eip7702: false },
    collectionSlug: slug || undefined,
  };
}

const MINT_QUERY = `query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address, $capabilities: WalletCapabilities) {
  swap(address: $address, fromAssets: $fromAssets, toAssets: $toAssets, recipient: $recipient, action: MINT, capabilities: $capabilities) {
    actions {
      __typename
      ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier gasLimitBufferMultiplier } } }
      ... on MintAction { transactionSubmissionData { to data value chain { networkId identifier gasLimitBufferMultiplier } } }
      ... on UserOpAction { actionBundleToken chain { identifier } calls { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier gasLimitBufferMultiplier } } } } }
    }
    errors { __typename message }
  }
}`;

function pickTx(actions) {
  for (const a of actions || []) {
    if (a.transactionSubmissionData) return { action: a, tx: a.transactionSubmissionData };
    for (const c of a.calls || []) if (c.transactionSubmissionData) return { action: c, tx: c.transactionSubmissionData };
  }
  return null;
}

async function fetchMintAction(walletAddress, config) {
  const baseHeaders = {
    'content-type': 'application/json',
    'accept': 'application/graphql-response+json, application/json',
    'x-signed-query': 'false',
    'origin': 'https://opensea.io',
    'referer': `https://opensea.io/collection/${config.slug}/overview`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };
  if (env.OPENSEA_COOKIE) baseHeaders.cookie = env.OPENSEA_COOKIE;
  if (env.OPENSEA_FINGERPRINT) baseHeaders['x-opensea-fingerprint'] = env.OPENSEA_FINGERPRINT;
  if (env.OPENSEA_SESSION) baseHeaders['x-opensea-session'] = env.OPENSEA_SESSION;
  const endpoints = env.GQL_ENDPOINT ? [env.GQL_ENDPOINT] : ['https://opensea.io/__api/graphql', 'https://gql.opensea.io/graphql'];
  const body = JSON.stringify({ operationName: 'MintActionTimelineQuery', query: MINT_QUERY, variables: buildVars(walletAddress, config.nft, config.quantity, config.slug) });
  let lastErr;
  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const headers = { ...baseHeaders };
        if (endpoint.includes('gql.opensea.io')) {
          headers['x-app-id'] = 'os2-web';
          if (env.OPENSEA_JWT) headers.authorization = `Bearer ${env.OPENSEA_JWT}`;
        }
        const res = await fetch(endpoint, { method: 'POST', headers, body });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`OpenSea non-JSON ${res.status}: ${text.slice(0, 200)}`); }
        if (!res.ok || json.errors) {
          const msg = `OpenSea GraphQL error ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 500)}`;
          const err = new Error(msg); err.status = res.status; throw err;
        }
        return json.data?.swap;
      } catch (e) {
        lastErr = e;
        const msg = e.shortMessage || e.message || String(e);
        const status = e.status || Number((msg.match(/GraphQL error (\d+)/) || [])[1]);
        const retryable = (attempt < 3) && (status === 429 || status === 503 || /timeout|ECONNRESET|network|fetch/i.test(msg));
        if (retryable) { await sleep(1000 * attempt); continue; }
        if (!env.GQL_ENDPOINT && [401, 403].includes(status) && endpoint !== endpoints[endpoints.length - 1]) break;
        throw e;
      }
    }
  }
  throw lastErr || new Error('OpenSea GraphQL failed');
}

// ─── [PATCH 2] CACHED PROOF FALLBACK ─────────────────────────────────────────
// For allowlist FCFS: OpenSea GraphQL returns mintAllowList/mintSigned calldata
// with proof embedded. We cache it per-wallet so retries don't need OpenSea again.
const txDataCache = new Map(); // wallet.address → txData

// No direct on-chain fallback for allowlist — proof is required from OpenSea.
// If OpenSea fails AND we have no cache, that wallet cannot mint.

// ─── BROADCAST ────────────────────────────────────────────────────────────────
async function broadcastRawToAll(providers, raw) {
  const started = Date.now();
  const results = await Promise.allSettled(providers.map(async ({ provider, url }) => {
    const sent = await provider.broadcastTransaction(raw);
    return { ok: true, hash: sent.hash, url, ms: Date.now() - started };
  }));
  return results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.shortMessage || r.reason?.message || String(r.reason) });
}

// ─── PRIVATE RELAY / BUNDLE HOOKS ───────────────────────────────────────────
// Supports generic Flashbots-style JSON-RPC relays:
// - eth_sendPrivateTransaction({ tx, maxBlockNumber? })
// - eth_sendBundle({ txs, blockNumber, minTimestamp?, maxTimestamp? })
// Notes:
// - Some relays require a signature header. Set PRIVATE_RELAY_AUTH_KEY to an
//   arbitrary auth wallet private key (NOT a funded mint wallet) for
//   X-Flashbots-Signature-compatible relays.
// - 48Club/BSC/private builders can be added via PRIVATE_TX_RELAYS or
//   BUNDLE_RELAYS if they speak compatible methods.
function relayHeaders(body) {
  const headers = { 'content-type': 'application/json' };
  if (env.PRIVATE_RELAY_AUTH_KEY) {
    const auth = new ethers.Wallet(env.PRIVATE_RELAY_AUTH_KEY.startsWith('0x') ? env.PRIVATE_RELAY_AUTH_KEY : `0x${env.PRIVATE_RELAY_AUTH_KEY}`);
    const digest = ethers.id(body);
    headers['X-Flashbots-Signature'] = `${auth.address}:${auth.signingKey.sign(digest).serialized}`;
  }
  if (env.PRIVATE_RELAY_EXTRA_HEADERS) {
    try { Object.assign(headers, JSON.parse(env.PRIVATE_RELAY_EXTRA_HEADERS)); } catch (e) { console.log(`[${nowIso()}] bad PRIVATE_RELAY_EXTRA_HEADERS: ${e.message}`); }
  }
  return headers;
}

async function relayRpc(url, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  const res = await fetch(url, { method: 'POST', headers: relayHeaders(body), body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`relay non-json ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok || json.error) throw new Error(`relay ${res.status}: ${JSON.stringify(json.error || json).slice(0, 300)}`);
  return json.result;
}

async function sendPrivateTransaction(raw, maxBlockNumber = null) {
  const relays = listEnv('PRIVATE_TX_RELAYS');
  if (!relays.length) return [];
  const params = [{ tx: raw }];
  if (maxBlockNumber != null) params[0].maxBlockNumber = ethers.toQuantity(maxBlockNumber);
  const started = Date.now();
  const results = await Promise.allSettled(relays.map(async url => {
    const result = await relayRpc(url, env.PRIVATE_TX_METHOD || 'eth_sendPrivateTransaction', params);
    return { ok: true, relay: url, result, ms: Date.now() - started };
  }));
  return results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || String(r.reason) });
}

async function sendBundle(raws, targetBlock) {
  const relays = listEnv('BUNDLE_RELAYS');
  if (!relays.length) return [];
  const bundle = { txs: raws, blockNumber: ethers.toQuantity(targetBlock) };
  if (env.BUNDLE_MIN_TIMESTAMP) bundle.minTimestamp = Number(env.BUNDLE_MIN_TIMESTAMP);
  if (env.BUNDLE_MAX_TIMESTAMP) bundle.maxTimestamp = Number(env.BUNDLE_MAX_TIMESTAMP);
  const started = Date.now();
  const results = await Promise.allSettled(relays.map(async url => {
    const result = await relayRpc(url, env.BUNDLE_METHOD || 'eth_sendBundle', [bundle]);
    return { ok: true, relay: url, result, ms: Date.now() - started };
  }));
  return results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || String(r.reason) });
}

async function broadcastRace(providers, raw, publicOk = true) {
  const hash = ethers.keccak256(raw);
  const tasks = [];
  if (publicOk) tasks.push(broadcastRawToAll(providers, raw).then(x => ({ kind: 'public', results: x })));
  tasks.push(sendPrivateTransaction(raw).then(x => ({ kind: 'private', results: x })));
  const settled = await Promise.allSettled(tasks);
  const groups = settled.map(r => r.status === 'fulfilled' ? r.value : { kind: 'unknown', results: [{ ok: false, error: r.reason?.message || String(r.reason) }] });
  return { hash, groups };
}

async function dispatchBundleForWallet(provider, providers, wallet, baseTx, logPrefix) {
  const block = await provider.getBlockNumber();
  const offsets = (env.BUNDLE_BLOCK_OFFSETS || '1,2,3').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
  const tx = { ...baseTx };
  const raw = await wallet.signTransaction(tx);
  const hash = ethers.keccak256(raw);
  const all = [];
  for (const off of offsets) {
    const br = await sendBundle([raw], block + off);
    const oks = br.filter(x => x.ok).length;
    console.log(`${logPrefix} bundle target=+${off} hash=${hash.slice(0,10)} ok=${oks}/${br.length}`);
    all.push(...br.map(x => ({ ...x, targetBlock: block + off })));
  }
  if (bool('BUNDLE_ALSO_PUBLIC', false)) {
    const pub = await broadcastRawToAll(providers, raw);
    console.log(`${logPrefix} bundle-public hash=${hash.slice(0,10)} ok=${pub.filter(x=>x.ok).length}/${pub.length}`);
    all.push(...pub.map(x => ({ ...x, route: 'public' })));
  }
  return [{ hash, raw, tier: 100n, oks: all.filter(x => x.ok).length, br: all }];
}

// ─── [PATCH 3] TRIPLE-FIRE BURST ─────────────────────────────────────────────
async function tripleFire(providers, wallet, baseTx, logPrefix) {
  const gasTiers = (env.FIRE_GAS_TIERS || '250,150,100')
    .split(',')
    .map(x => BigInt(String(x).trim()))
    .filter(x => x > 0n); // send highest first so the fastest tx is already aggressive
  const results = [];

  for (const tier of gasTiers) {
    const tx = { ...baseTx };
    tx.maxFeePerGas = baseTx.maxFeePerGas * tier / 100n;
    tx.maxPriorityFeePerGas = baseTx.maxPriorityFeePerGas * tier / 100n;
    const raw = await wallet.signTransaction(tx);
    const publicOk = (env.BROADCAST_ROUTE || 'hybrid').toLowerCase() !== 'private';
    const sent = await broadcastRace(providers, raw, publicOk);
    const hash = sent.hash;
    const br = sent.groups.flatMap(g => (g.results || []).map(x => ({ ...x, route: g.kind })));
    const oks = br.filter(x => x.ok).length;
    console.log(`${logPrefix} tier=${tier}% hash=${hash.slice(0,10)} ok=${oks}/${br.length}`);
    results.push({ hash, raw, tier, oks, br });
  }
  return results;
}

async function fireByRoute(provider, providers, wallet, baseTx, logPrefix) {
  const route = (env.BROADCAST_ROUTE || 'hybrid').toLowerCase();
  if (route === 'bundle') return dispatchBundleForWallet(provider, providers, wallet, baseTx, logPrefix);
  return tripleFire(providers, wallet, baseTx, logPrefix);
}

// ─── [PATCH 9] BALANCE CHECK ─────────────────────────────────────────────────
async function checkBalance(provider, wallet, requiredValue, gasEstimate) {
  const balance = await provider.getBalance(wallet.address);
  const needed = requiredValue + gasEstimate;
  if (balance < needed) {
    console.log(`[${nowIso()}] ⚠️ ${shortAddr(wallet.address)} underfunded: has ${ethers.formatEther(balance)} ETH, needs ~${ethers.formatEther(needed)} ETH`);
    return false;
  }
  return true;
}

// ─── [PATCH 10] REPLACEMENT BUMP LOOP ────────────────────────────────────────
async function findAnyReceipt(provider, hashes) {
  for (const hash of hashes) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt) return receipt;
  }
  return null;
}

async function waitForAnyReceipt(provider, wallet, nonce, hashes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await findAnyReceipt(provider, hashes);
    if (receipt) return receipt;
    const currentNonce = await provider.getTransactionCount(wallet.address, 'latest').catch(() => nonce);
    if (currentNonce > nonce) return 'nonce_advanced';
    await sleep(1500);
  }
  return null;
}

async function replacementBumpLoop(provider, providers, wallet, baseTx, hashes, logPrefix) {
  const bumpIntervalMs = int('BUMP_INTERVAL_MS', 12000); // check every ~1 block
  const maxBumps = int('MAX_BUMPS', 5);
  const bumpMultipliers = (env.BUMP_MULTIPLIERS || '350,500,700,1000,1500')
    .split(',')
    .map(x => BigInt(String(x).trim()))
    .filter(x => x > 0n); // escalating: 3.5x → 15x base by default

  for (let i = 0; i < maxBumps; i++) {
    await sleep(bumpIntervalMs);
    const receipt = await findAnyReceipt(provider, hashes);
    if (receipt) {
      console.log(`${logPrefix} confirmed before bump #${i + 1} hash=${receipt.hash?.slice(0, 10)}`);
      return receipt;
    }
    const currentNonce = await provider.getTransactionCount(wallet.address, 'latest');
    if (currentNonce > baseTx.nonce) {
      console.log(`${logPrefix} nonce advanced (${baseTx.nonce} → ${currentNonce}), tx included`);
      return 'nonce_advanced';
    }
    const mult = bumpMultipliers[i] || bumpMultipliers[bumpMultipliers.length - 1];
    const bumpTx = { ...baseTx };
    bumpTx.maxFeePerGas = baseTx.maxFeePerGas * mult / 100n;
    bumpTx.maxPriorityFeePerGas = baseTx.maxPriorityFeePerGas * mult / 100n;
    try {
      const raw = await wallet.signTransaction(bumpTx);
      const hash = ethers.keccak256(raw);
      hashes.push(hash);
      const br = await broadcastRawToAll(providers, raw);
      const oks = br.filter(x => x.ok).length;
      console.log(`${logPrefix} bump #${i + 1} mult=${mult}% hash=${hash.slice(0, 10)} ok=${oks}/${br.length}`);
    } catch (e) {
      console.log(`${logPrefix} bump #${i + 1} error: ${e.message.slice(0, 100)}`);
    }
  }
  return null;
}

// ─── [PATCH 7] BLOCK TIMESTAMP SYNC ──────────────────────────────────────────
async function waitForChainTime(provider, targetTimestamp) {
  console.log(`[${nowIso()}] waiting for chain time >= ${new Date(targetTimestamp * 1000).toISOString()}`);
  while (true) {
    try {
      const block = await provider.getBlock('latest');
      if (block.timestamp >= targetTimestamp) {
        console.log(`[${nowIso()}] chain time ready: block ${block.number} ts=${block.timestamp}`);
        return block;
      }
      const diff = targetTimestamp - block.timestamp;
      if (diff > 15) await sleep(5000);
      else if (diff > 3) await sleep(1000);
      else await sleep(200);
    } catch (e) {
      await sleep(500);
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const { provider, providers } = await makeProvider();
  const keys = loadPrivateKeys();
  if (!keys.length) throw new Error('PRIVATE_KEY or PRIVATE_KEYS required');
  const wallets = keys.map(pk => new ethers.Wallet(pk, provider));

  const nft = ethers.getAddress(env.NFT_CONTRACT || req('NFT_CONTRACT'));
  const seaDropAddress = ethers.getAddress(env.SEADROP_CONTRACT || '0xYourNftContract');
  const slug = env.OPENSEA_SLUG || req('OPENSEA_SLUG');
  const quantity = BigInt(env.QUANTITY || '2');
  const mintPrice = ethers.parseEther(env.MINT_PRICE || '0.0035');
  const maxMintValue = env.MAX_MINT_VALUE_ETH ? ethers.parseEther(env.MAX_MINT_VALUE_ETH) : ethers.parseEther('0.5');
  const iface = new ethers.Interface(SEA_ABI);
  const sea = new ethers.Contract(seaDropAddress, SEA_ABI, provider);

  const startAt = env.START_AT || req('START_AT');
  const startMs = Date.parse(startAt);
  if (!Number.isFinite(startMs)) throw new Error(`Bad START_AT: ${startAt}`);
  const startTimestamp = Math.floor(startMs / 1000);

  // [PATCH 6] Aggressive EIP-1559 gas config
  // BASE_FEE_MULTIPLIER/GAS_MULTIPLIER controls maxFee = baseFee * multiplier + priority.
  // PRIORITY_GWEI or eth_maxPriorityFeePerGas controls miner/validator tip.
  const gasMultiplier = BigInt(int('BASE_FEE_MULTIPLIER', int('GAS_MULTIPLIER', 300)));
  const priorityGwei = env.PRIORITY_GWEI || env.MIN_PRIORITY_GWEI || 'auto';

  console.log(`[${nowIso()}] === FCFS WHITELIST TEMPLATE — MODE GEBER ===`);
  console.log(`nft=${nft} seadrop=${seaDropAddress} slug=${slug}`);
  console.log(`chain=${chainIdentifier} wallets=${wallets.length} fanout=${providers.length} dryRun=${dryRun}`);
  console.log(`route=${(env.BROADCAST_ROUTE || 'hybrid').toLowerCase()} privateRelays=${listEnv('PRIVATE_TX_RELAYS').length} bundleRelays=${listEnv('BUNDLE_RELAYS').length}`);
  console.log(`quantity=${quantity} mintPrice=${ethers.formatEther(mintPrice)} ETH`);
  console.log(`START_AT=${startAt} (${new Date(startMs).toISOString()})`);
  console.log(`gasMultiplier=${gasMultiplier}% priorityGwei=${priorityGwei}`);
  console.log(`gas: estimateAtFire=${bool('ESTIMATE_GAS_AT_FIRE', true)} gasBuffer=${int('GAS_LIMIT_BUFFER_PCT', 130)}%`);

  // Get fee recipient
  let feeRecipient = env.FEE_RECIPIENT || '';
  if (!feeRecipient) {
    try {
      const allowed = await sea.getAllowedFeeRecipients(nft);
      feeRecipient = allowed?.[0] || ethers.ZeroAddress;
    } catch { feeRecipient = ethers.ZeroAddress; }
  }
  feeRecipient = ethers.getAddress(feeRecipient);
  console.log(`feeRecipient=${feeRecipient}`);

  // [PATCH 5] Supply check
  async function checkSupply() {
    try {
      const stats = await sea.getMintStats(nft, wallets[0].address);
      const supply = BigInt(stats[1]);
      const max = BigInt(stats[2]);
      console.log(`[${nowIso()}] supply: ${supply}/${max} (${max - supply} remaining)`);
      if (supply >= max) {
        console.error(`[${nowIso()}] SOLD OUT! Aborting.`);
        process.exit(1);
      }
      return { supply, max };
    } catch (e) {
      console.log(`[${nowIso()}] supply check failed (non-fatal): ${e.message}`);
      return null;
    }
  }

  // Pre-arm window: start 90s before (configurable)
  const prearmWindowMs = int('PREARM_WINDOW_MS', 90000);
  const prearmStart = startMs - prearmWindowMs;

  if (Date.now() < prearmStart) {
    const waitSec = Math.ceil((prearmStart - Date.now()) / 1000);
    console.log(`[${nowIso()}] waiting ${waitSec}s until pre-arm window...`);
    await sleepUntil(prearmStart);
  }

  console.log(`[${nowIso()}] === PRE-ARM PHASE (parallel) ===`);

  // [PATCH 1] Parallel pre-arm — all wallets simultaneously
  const maxRetries = int('PREARM_RETRIES', 999); // effectively infinite until deadline
  const retryDelayMs = int('PREARM_RETRY_DELAY_MS', 500);
  const retryDeadlineMs = startMs + int('PREARM_DEADLINE_EXTRA_MS', 30000);
  async function prearmWallet(wallet) {
    // Check cache first (from previous failed run or retry)
    if (txDataCache.has(wallet.address)) {
      const cached = txDataCache.get(wallet.address);
      console.log(`[${nowIso()}] ✓ prearmed ${shortAddr(wallet.address)} (CACHED) value=${ethers.formatEther(cached.value)} ETH`);
      return { wallet, txData: cached };
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (Date.now() > retryDeadlineMs) {
        console.log(`[${nowIso()}] deadline passed for ${shortAddr(wallet.address)}`);
        return null;
      }
      try {
        // Check if already minted
        const stats = await sea.getMintStats(nft, wallet.address).catch(() => null);
        if (stats && BigInt(stats[0]) >= quantity) {
          console.log(`[${nowIso()}] skip ${shortAddr(wallet.address)}: already minted`);
          return null;
        }

        let txData;
        // Try OpenSea GraphQL (required for allowlist — proof is in calldata)
        try {
          const action = await fetchMintAction(wallet.address, { nft, slug, quantity });
          const picked = pickTx(action?.actions);
          if (!picked) {
            if (attempt % 20 === 0) console.log(`[${nowIso()}] no action for ${shortAddr(wallet.address)} (attempt ${attempt}/${maxRetries})`);
            await sleep(retryDelayMs);
            continue;
          }
          txData = { to: picked.tx.to, data: picked.tx.data, value: BigInt(picked.tx.value || '0') };
        } catch (e) {
          if (attempt % 10 === 0) console.log(`[${nowIso()}] ${shortAddr(wallet.address)} OpenSea error: ${e.message.slice(0, 100)}`);
          await sleep(retryDelayMs);
          continue;
        }

        // Validate value
        const value = BigInt(txData.value || '0');
        if (value > maxMintValue) throw new Error(`value too high: ${ethers.formatEther(value)} ETH`);

        // Validate calldata — must be mintAllowList or mintSigned for allowlist
        const parsed = iface.parseTransaction({ data: txData.data, value });
        if (!['mintSigned', 'mintAllowList'].includes(parsed.name)) {
          console.log(`[${nowIso()}] ${shortAddr(wallet.address)} got ${parsed.name} instead of allowlist fn (attempt ${attempt})`);
          await sleep(retryDelayMs);
          continue;
        }

        // Cache the txData for retry/replacement use
        txDataCache.set(wallet.address, txData);
        await decodeAndLogMintCalldata(iface, txData, wallet.address);

        console.log(`[${nowIso()}] ✓ prearmed ${shortAddr(wallet.address)} fn=${parsed.name} value=${ethers.formatEther(txData.value)} ETH`);
        logEvent({ wallet: wallet.address, status: 'prearmed', fn: parsed.name, valueEth: ethers.formatEther(txData.value) });
        return { wallet, txData };
      } catch (e) {
        if (attempt < maxRetries && Date.now() < retryDeadlineMs) {
          await sleep(retryDelayMs);
          continue;
        }
        console.error(`[${nowIso()}] ${shortAddr(wallet.address)} prearm FAILED: ${e.message}`);
        logEvent({ wallet: wallet.address, status: 'prearm_error', error: e.message });
        return null;
      }
    }
    return null;
  }

  // Fire all pre-arms in parallel
  const prearmResults = await Promise.all(wallets.map(w => prearmWallet(w)));
  const armed = prearmResults.filter(Boolean);

  if (armed.length === 0) {
    console.error(`[${nowIso()}] FATAL: no wallets armed. Aborting.`);
    process.exit(1);
  }
  console.log(`[${nowIso()}] ${armed.length}/${wallets.length} wallets armed`);

  if (preflightOnly) {
    console.log(`[${nowIso()}] --preflight mode, stopping here.`);
    return;
  }

  // [PATCH 5] Supply check before fire
  await checkSupply();

  // [PATCH 7] Wait for chain time OR local clock, whichever comes first
  const sendEarlyMs = int('SEND_EARLY_MS', 500);
  const localFireTime = startMs - sendEarlyMs;

  if (Date.now() < localFireTime) {
    console.log(`[${nowIso()}] waiting for fire time...`);
    // Race: local clock vs chain timestamp
    await Promise.race([
      sleepUntil(localFireTime),
      waitForChainTime(provider, startTimestamp)
    ]);
  } else {
    console.log(`[${nowIso()}] already past START_AT, firing immediately!`);
  }

  // [PATCH 5] Final supply check + quantity adjustment
  const supplyInfo = await checkSupply();

  // [PATCH 11] Adjust quantity if supply almost gone
  if (supplyInfo) {
    const remaining = supplyInfo.max - supplyInfo.supply;
    if (remaining <= 0n) {
      console.error(`[${nowIso()}] SOLD OUT at fire time! Aborting.`);
      process.exit(1);
    }
    if (remaining < quantity * BigInt(armed.length)) {
      console.log(`[${nowIso()}] ⚠️ only ${remaining} remaining for ${armed.length} wallets × ${quantity} qty`);
    }
  }

  console.log(`[${nowIso()}] === FIRE! ===`);

  // [PATCH 4] Fetch nonces RIGHT NOW (not during pre-arm)
  const feePlan = await buildFeePlan(provider, 'fire');
  const fallbackGasLimit = BigInt(int('GAS_LIMIT', 350000));
  const maxFee = feePlan.maxFeePerGas;
  const maxPriority = feePlan.maxPriorityFeePerGas;
  const gasEstimate = maxFee * BigInt(int('MAX_GAS_LIMIT', Number(fallbackGasLimit))); // worst-case balance check buffer

  // [PATCH 3 + 9] Triple-fire all wallets in parallel (with balance check)
  const fireResults = await Promise.all(armed.map(async ({ wallet, txData }) => {
    try {
      // [PATCH 9] Balance check
      const hasFunds = await checkBalance(provider, wallet, BigInt(txData.value), gasEstimate);
      if (!hasFunds) {
        logEvent({ wallet: wallet.address, status: 'skipped_underfunded' });
        return { wallet, status: 'skipped_underfunded' };
      }

      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      const gasLimitBig = await estimateGasLimit(provider, wallet, txData, fallbackGasLimit);
      const baseTx = {
        chainId: chainIdFor(),
        type: 2,
        to: ethers.getAddress(txData.to),
        data: txData.data,
        value: txData.value,
        gasLimit: gasLimitBig,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPriority,
        nonce,
      };

      if (dryRun) {
        console.log(`[${nowIso()}] [DRY-RUN] would fire ${shortAddr(wallet.address)} nonce=${nonce} value=${ethers.formatEther(txData.value)}`);
        logEvent({ wallet: wallet.address, status: 'dry_run', nonce });
        return { wallet, status: 'dry_run' };
      }

      const results = await fireByRoute(provider, providers, wallet, baseTx, `[${nowIso()}] ${shortAddr(wallet.address)}`);
      const hashes = results.map(r => r.hash).filter(Boolean);
      logEvent({ wallet: wallet.address, status: 'fired', nonce, hashes });
      return { wallet, status: 'fired', hashes, nonce, baseTx };
    } catch (e) {
      console.error(`[${nowIso()}] ${shortAddr(wallet.address)} FIRE ERROR: ${e.message}`);
      logEvent({ wallet: wallet.address, status: 'fire_error', error: e.message });
      return { wallet, status: 'error', error: e.message };
    }
  }));

  // [PATCH 10] Replacement bump loop + receipt waiting
  console.log(`[${nowIso()}] === WAITING FOR RECEIPTS (with replacement bumps) ===`);
  const receiptTimeout = int('RECEIPT_TIMEOUT_MS', 120000);

  await Promise.all(fireResults.filter(r => r.status === 'fired').map(async ({ wallet, hashes, nonce, baseTx }) => {
    const logPfx = `[${nowIso()}] ${shortAddr(wallet.address)}`;
    try {
      // Track every same-nonce candidate hash, including later bumps.
      const [receipt, bumpResult] = await Promise.all([
        waitForAnyReceipt(provider, wallet, nonce, hashes, receiptTimeout),
        replacementBumpLoop(provider, providers, wallet, baseTx, hashes, logPfx)
      ]);

      const finalReceipt = (receipt && receipt !== 'nonce_advanced') ? receipt : (bumpResult && bumpResult !== 'nonce_advanced' ? bumpResult : null);

      if (finalReceipt && finalReceipt.status !== undefined) {
        const status = finalReceipt.status === 1 ? '✅ CONFIRMED' : '❌ REVERTED';
        console.log(`[${nowIso()}] ${status} ${shortAddr(wallet.address)} hash=${finalReceipt.hash} block=${finalReceipt.blockNumber} gas=${finalReceipt.gasUsed}`);
        logEvent({ wallet: wallet.address, status: finalReceipt.status === 1 ? 'confirmed' : 'reverted', hash: finalReceipt.hash, blockNumber: finalReceipt.blockNumber, gasUsed: String(finalReceipt.gasUsed), hashes });
      } else if (receipt === 'nonce_advanced' || bumpResult === 'nonce_advanced') {
        console.log(`[${nowIso()}] ${shortAddr(wallet.address)} nonce advanced, tx included via one of ${hashes.length} candidates`);
        logEvent({ wallet: wallet.address, status: 'nonce_advanced', nonce, hashes });
      } else {
        const currentNonce = await provider.getTransactionCount(wallet.address, 'latest').catch(() => nonce);
        if (currentNonce > nonce) {
          console.log(`[${nowIso()}] ${shortAddr(wallet.address)} nonce advanced (${nonce} → ${currentNonce})`);
          logEvent({ wallet: wallet.address, status: 'nonce_advanced', nonce, currentNonce, hashes });
        } else {
          console.log(`[${nowIso()}] ${shortAddr(wallet.address)} receipt timeout after all bumps`);
          logEvent({ wallet: wallet.address, status: 'timeout', hashes });
        }
      }
    } catch (e) {
      console.log(`[${nowIso()}] ${shortAddr(wallet.address)} receipt/bump error: ${e.message}`);
      logEvent({ wallet: wallet.address, status: 'receipt_error', hashes, error: e.message });
    }
  }));

  // [PATCH 12] Post-revert retry — if tx reverted (timing/supply race), retry once with fresh data
  const reverted = fireResults.filter(r => r.status === 'fired').length > 0;
  const confirmedCount = fireResults.filter(r => r.status === 'fired').length; // will check logs
  
  // Check if any wallet got reverted and supply still available
  const revertedWallets = [];
  for (const r of fireResults) {
    if (r.status !== 'fired') continue;
    try {
      const receipt = await findAnyReceipt(provider, r.hashes || []).catch(() => null);
      if (receipt && receipt.status === 0) {
        revertedWallets.push(r);
      }
    } catch {}
  }

  if (revertedWallets.length > 0) {
    console.log(`[${nowIso()}] ${revertedWallets.length} wallet(s) reverted — attempting retry...`);
    const retrySupply = await checkSupply();
    if (retrySupply && retrySupply.max - retrySupply.supply > 0n) {
      console.log(`[${nowIso()}] supply still available (${retrySupply.max - retrySupply.supply} left), retrying reverted wallets...`);
      
      // Re-fetch proof from cache (already cached during pre-arm)
      const retryPlan = await buildFeePlan(provider, 'retry');
      const retryMaxFee = pctBump(retryPlan.maxFeePerGas, int('RETRY_FEE_MULTIPLIER', 200));
      const retryMaxPriority = pctBump(retryPlan.maxPriorityFeePerGas, int('RETRY_PRIORITY_MULTIPLIER', 200));

      await Promise.all(revertedWallets.map(async ({ wallet }) => {
        try {
          const cachedTx = txDataCache.get(wallet.address);
          if (!cachedTx) { console.log(`[${nowIso()}] no cached tx for ${shortAddr(wallet.address)}, skip retry`); return; }
          
          const nonce = await provider.getTransactionCount(wallet.address, 'pending');
          const gasLimitBig = await estimateGasLimit(provider, wallet, cachedTx, fallbackGasLimit);
          const retryTx = {
            chainId: chainIdFor(),
            type: 2,
            to: ethers.getAddress(cachedTx.to),
            data: cachedTx.data,
            value: cachedTx.value,
            gasLimit: gasLimitBig,
            maxFeePerGas: retryMaxFee,
            maxPriorityFeePerGas: retryMaxPriority,
            nonce,
          };
          const results = await fireByRoute(provider, providers, wallet, retryTx, `[${nowIso()}] RETRY ${shortAddr(wallet.address)}`);
          logEvent({ wallet: wallet.address, status: 'retry_fired', nonce, hashes: results.map(r => r.hash) });
        } catch (e) {
          console.log(`[${nowIso()}] retry failed ${shortAddr(wallet.address)}: ${e.message}`);
        }
      }));

      // Wait for retry receipts
      await sleep(15000);
      for (const { wallet } of revertedWallets) {
        try {
          const nonce = await provider.getTransactionCount(wallet.address, 'latest');
          console.log(`[${nowIso()}] ${shortAddr(wallet.address)} final nonce=${nonce}`);
        } catch {}
      }
    } else {
      console.log(`[${nowIso()}] supply exhausted, no retry possible`);
    }
  }

  // Final supply check
  await checkSupply();
  console.log(`[${nowIso()}] === DONE ===`);
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
