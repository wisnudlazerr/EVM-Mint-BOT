# EVM Mint BOT

OpenSea raw transaction sniper for EVM NFT whitelist / FCFS mints.

This repo is now **raw-only** on purpose: users do not need to understand SeaDrop proof tuples, mint params, ABI routes, or manual allowlist calldata. OpenSea prepares the raw mint transaction; this bot polls for it, then broadcasts with a same-nonce gas ladder.

## What it does

- Polls OpenSea GraphQL for a released raw mint transaction
- Requires fresh OpenSea JWT from browser session
- Supports preflight and dry-run before live send
- Broadcasts with same-nonce gas ladder
- Masks secrets in logs
- Keeps `.env`, private keys, JWTs, logs, proofs, and wallet files out of git

## Security warning

Use a burner wallet only.

Never commit or share:

- `.env`
- `PRIVATE_KEY`
- `OPENSEA_JWT`
- premium/private RPC URLs
- mint logs that include sensitive data

## Install

```bash
npm install
cp .env.example .env
```

## Required `.env`

```env
PRIVATE_KEY=***
RPC_URL=https://ethereum-rpc.publicnode.com
NFT_CONTRACT=0xYourNftContract
CHAIN_IDENTIFIER=ethereum
QUANTITY=1
MINT_MODE=opensea_raw
OPENSEA_COLLECTION_SLUG=your-collection-slug
OPENSEA_JWT=eyJ_replace_with_fresh_token
DRY_RUN=true
```

`MINT_MODE` is raw-only. Keep it:

```env
MINT_MODE=opensea_raw
```

## How to get OpenSea JWT

JWT is the browser login token OpenSea uses after your wallet/session is active.

Do this 5–10 minutes before FCFS / whitelist phase:

1. Open OpenSea collection page in browser
2. Connect/login wallet that will mint
3. Press `F12` / open Developer Tools
4. Open **Network** tab
5. Filter/search `graphql`
6. Refresh OpenSea page
7. Click a `graphql` request
8. Open **Headers**
9. Find:

```txt
Authorization: Bearer eyJ...
```

10. Copy only token after `Bearer `
11. Paste into `.env`:

```env
OPENSEA_JWT=eyJxxxxxxxxxxxxxxxx
```

JWT expires. Use a fresh one near mint time.

## Commands

### Check syntax

```bash
npm run check
```

### Analyze target

```bash
npm run analyze
```

Shows chain, contract code status, OpenSea stage if available, and recommended mode.

### Preflight

```bash
npm run preflight
```

Checks env, RPC, chain, contract, wallet derivation, and balance. No broadcast.

### Dry-run

```bash
npm run dry-run
```

Polls OpenSea for raw tx, builds cost summary, estimates gas, checks balance. No broadcast.

### Live mint

```bash
DRY_RUN=false npm start
```

Only use after preflight/dry-run are clean.

## Gas tiers

Default is balanced:

```env
FIRE_GAS_TIERS=300,220,160,120
```

For brutal FCFS war, manually raise:

```env
FIRE_GAS_TIERS=700,500,350,250,150
```

Same nonce means only one transaction should be mined, but the highest accepted tier can still be expensive on Ethereum mainnet.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `PRIVATE_KEY` | Live/dry-run | Burner wallet private key |
| `RPC_URL` | Yes | RPC endpoint |
| `NFT_CONTRACT` | Yes | NFT contract address |
| `CHAIN_IDENTIFIER` | Yes | `ethereum`, `base`, `polygon`, etc |
| `QUANTITY` | Yes | Mint quantity |
| `MINT_MODE` | Yes | Must be `opensea_raw` |
| `OPENSEA_COLLECTION_SLUG` | Yes | OpenSea collection slug |
| `OPENSEA_JWT` | Yes | Fresh OpenSea browser JWT |
| `OPENSEA_POLLS` | Yes | Poll attempts, default `120` |
| `OPENSEA_POLL_INTERVAL_MS` | Yes | Poll interval, default `1000` |
| `FIRE_GAS_TIERS` | Yes | Same-nonce gas ladder percentages |
| `DRY_RUN` | Yes | Keep `true` until ready |

## Troubleshooting

### `Missing OPENSEA_JWT in .env`

Take fresh JWT from browser Network tab and paste it into `.env`.

### `OpenSea raw transaction not released`

Phase may not be open yet, JWT may be expired, wallet may not be eligible, or OpenSea changed the GraphQL flow.

### `Invalid NFT_CONTRACT address`

Use a valid EVM contract address.

### `NFT_CONTRACT has no code on selected chain`

Wrong chain, wrong RPC, or wrong contract.

### `Insufficient balance`

Top up burner wallet or reduce gas/quantity.

### `gas too expensive`

Lower `FIRE_GAS_TIERS`, `BASE_FEE_MULTIPLIER`, or priority fee values.

## Safety design

- No hidden transfer logic
- No private key upload
- No telemetry
- No obfuscated code
- No suspicious dependencies
- Live broadcast requires explicit `DRY_RUN=false`
