# EVM Mint BOT

Public-safe geber template for EVM NFT whitelist / FCFS mint flows using a burner wallet.

This repo is built for whitelist/FCFS timing: preflight checks, dry-run simulation, aggressive fee planning, same-nonce gas ladder broadcast, and explicit live send. It does **not** bypass allowlists, CAPTCHA, signatures, or anti-bot rules.

## Security warning

Use a burner wallet only.

Never commit or share:

- `.env`
- private keys
- premium/private RPC URLs
- wallet lists
- proofs/signatures
- mint logs that include sensitive data

The logger masks private keys, auth keys, and tokenized RPC URLs, but you should still treat local logs as sensitive.

## Install

```bash
npm install
cp .env.example .env
```

## Configure `.env`

Required basics:

```env
PRIVATE_KEY=0xYOUR_BURNER_PRIVATE_KEY
RPC_URL=https://ethereum-rpc.publicnode.com
NFT_CONTRACT=0xYourNftContract
CHAIN_IDENTIFIER=ethereum
QUANTITY=1
MINT_PRICE=0
DRY_RUN=true
```

Whitelist / FCFS geber controls:

```env
MINT_MODE=allowlist
SEADROP_CONTRACT=0xYourSeaDropContract
START_AT=2026-01-01T00:00:00.000Z
FIRE_GAS_TIERS=700,500,350,250,150
MINT_PARAMS_JSON=["0","1","0","4102444800","0","0","0",false]
PROOF_JSON=[]
```

Modes:

- `allowlist` = SeaDrop `mintAllowList` with `MINT_PARAMS_JSON` + `PROOF_JSON`
- `signed` = SeaDrop `mintSigned` with `SALT` + `SIGNATURE`
- `public` = SeaDrop `mintPublic`
- `direct` = fallback direct contract call using `MINT_FUNCTION` + `MINT_ARGS_JSON`

`OPENSEA_SLUG` is currently logged as a placeholder. OpenSea cookie/session proof fetching is intentionally not wired to this public template.

## Commands

### Syntax check

```bash
npm run check
```

### Preflight

No broadcast. Checks env, RPC, chain id, wallet derivation, balances, and contract code.

```bash
npm run preflight
```

### Dry-run

No broadcast. Builds transaction, estimates gas, computes max cost, and checks balance.

```bash
npm run dry-run
```

### Live mint

Broadcast only when `DRY_RUN=false` and `PREFLIGHT_ONLY=false`.

```bash
DRY_RUN=false npm start
```

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `PRIVATE_KEY` | Live only | Burner wallet private key. Not required for config-only preflight. |
| `RPC_URL` | Yes | Public or private RPC endpoint. Parser supports `=` inside values. |
| `NFT_CONTRACT` | Yes | NFT contract address. Must contain code on selected chain. |
| `SEADROP_CONTRACT` | Optional | SeaDrop contract address for `mintPublic`. |
| `OPENSEA_SLUG` | Optional | Collection slug placeholder. No cookie/session fetch in public repo. |
| `MINT_MODE` | Yes | `allowlist`, `signed`, `public`, or `direct`. Default `allowlist`. |
| `FIRE_GAS_TIERS` | Yes | Same-nonce gas ladder percentages. Example `700,500,350,250,150`. |
| `MINT_PARAMS_JSON` | Allowlist/signed | SeaDrop mint params tuple. Keep real values out of git if sensitive. |
| `PROOF_JSON` | Allowlist | Merkle proof array. Do not commit real proof files. |
| `SALT` / `SIGNATURE` | Signed | Required for `MINT_MODE=signed`. |
| `MINT_FUNCTION` / `MINT_ARGS_JSON` | Direct | Fallback for non-SeaDrop contracts. |
| `CHAIN_IDENTIFIER` | Yes | Example: `ethereum`, `base`, `polygon`, `arbitrum`. |
| `QUANTITY` | Yes | Positive integer. |
| `MINT_PRICE` | Yes | ETH value per mint. |
| `MAX_MINT_VALUE_ETH` | Yes | Safety ceiling used in validation/reporting. |
| `START_AT` | Optional | ISO datetime. Bot waits until this timestamp before dry-run/live path. |
| `DRY_RUN` | Yes | Keep `true` until ready to broadcast. |
| `PREFLIGHT_ONLY` | Optional | Forces preflight-only mode. |
| `GAS_LIMIT` | Yes | Fallback gas limit if estimation fails. |
| `BASE_FEE_MULTIPLIER` | Yes | Percent multiplier for base fee. Example `300` = 3x. |
| `MIN_PRIORITY_GWEI` | Yes | Minimum priority fee. |
| `MAX_PRIORITY_GWEI` | Yes | Maximum priority fee. |
| `BROADCAST_ROUTE` | Yes | `public`, `private`, or `hybrid`. Private relay is stubbed by design. |
| `PRIVATE_RELAY_URL` | Private route | Relay endpoint if you implement private broadcast. |
| `PRIVATE_RELAY_AUTH_KEY` | Private route | Auth key. Masked in logs. |

## Project structure

```txt
src/
  index.js       CLI entrypoint
  config.js      env parsing and validation
  env.js         .env parser
  rpc.js         RPC connection and chain checks
  wallet.js      burner wallet helpers
  opensea.js     OpenSea proof placeholder
  mint.js        tx builder
  gas.js         fee plan and gas estimate
  broadcast.js   public/private broadcast routing
  logger.js      safe console/jsonl logging
  abi/seadrop.js SeaDrop ABI
```

## Troubleshooting

### `Missing RPC_URL in .env`

Copy `.env.example` to `.env` and fill `RPC_URL`.

### `Invalid NFT_CONTRACT address`

Use a checksummed or valid hex EVM address. Do not use `0xYourNftContract` in real runs.

### `NFT_CONTRACT has no code on selected chain`

Wrong chain, wrong RPC, or wrong contract address.

### `Insufficient balance`

Burner wallet balance is below mint value plus max gas cost. Top up burner or reduce quantity/gas.

### `mint not started`

Set `START_AT` correctly. The bot waits until `START_AT` before dry-run/live mint path.

### `gas too low`

Increase `GAS_LIMIT`, `BASE_FEE_MULTIPLIER`, or priority fee settings.

### `OpenSea proof unavailable`

This public template does not fetch private/protected OpenSea proofs. Paste or implement proof flow only if you understand target contract ABI and never commit proof files.

## Safety design

- No hidden transfer logic.
- No private key upload.
- No telemetry.
- No obfuscated code.
- No suspicious dependencies.
- Live broadcast requires explicit `DRY_RUN=false`.
- Same-nonce gas ladder uses public RPC fanout; private relay path is stubbed until user wires their own relay.
