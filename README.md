# EVM Mint BOT

Clean whitelist / FCFS NFT mint bot template for EVM chains.

Built for burner wallets and time-sensitive mint windows.

## Features

- Whitelist / FCFS mint template
- Scheduled `START_AT` execution
- Burner-wallet focused `.env` config
- Dry-run mode before real mint
- Custom mint function name
- Custom mint args via JSON
- Manual gas controls
- Simple, readable Node.js script

## Safety

Use a burner wallet only.

Never commit:

- `.env`
- private keys
- paid/private RPC URLs
- mint logs
- wallet lists
- signatures/proofs that should stay private

This repo includes `.gitignore` for those files.

## Install

```bash
npm install
```

## Setup

```bash
cp .env.example .env
nano .env
```

Required fields:

```env
PRIVATE_KEY=0xYOUR_BURNER_PRIVATE_KEY
RPC_URL=https://ethereum-rpc.publicnode.com
NFT_CONTRACT=0xYourNftContract
MINT_FUNCTION=mint
QUANTITY=1
VALUE_ETH=0
START_AT=2026-01-01T00:00:00.000Z
DRY_RUN=true
```

## Run dry-run

```bash
npm run check
node whitelist-fcfs-mint-bot.js
```

Keep `DRY_RUN=true` first. Verify calldata, value, target contract, wallet, and estimated gas.

## Real mint

Set:

```env
DRY_RUN=false
```

Then run:

```bash
node whitelist-fcfs-mint-bot.js
```

## Mint args

If the mint function requires extra args, set `MINT_ARGS_JSON`.

Example:

```env
MINT_FUNCTION=allowlistMint
QUANTITY=1
MINT_ARGS_JSON=[["0xproof1","0xproof2"]]
```

The bot will append quantity/value based on the template logic. Adjust the script if your target contract has a custom ABI shape.

## Notes

This template does not bypass allowlists, signatures, CAPTCHA, or anti-bot protections. It only automates transaction preparation and submission for wallets that are allowed to mint.
