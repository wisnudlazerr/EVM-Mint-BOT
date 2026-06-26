const OPENSEA_GQL_URL = "https://gql.opensea.io/graphql";

const MINT_ACTION_TIMELINE_QUERY = `query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address, $capabilities: WalletCapabilities) {
  swap(address: $address, fromAssets: $fromAssets, toAssets: $toAssets, recipient: $recipient, action: MINT, capabilities: $capabilities) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData {
          to
          data
          value
          chain { networkId identifier }
        }
      }
      ... on UserOpAction {
        calls {
          __typename
          ... on TransactionAction {
            transactionSubmissionData { to data value chain { networkId identifier } }
          }
        }
      }
    }
    errors { __typename }
  }
}`;

function assetQuantity(config) {
  return {
    item: {
      chain: { identifier: config.chainIdentifier },
      contractAddress: config.nftContract,
      tokenId: null,
    },
    quantity: String(config.quantity),
  };
}

function extractRawTx(payload) {
  const actions = payload?.data?.swap?.actions || [];
  for (const action of actions) {
    const direct = action?.transactionSubmissionData;
    if (direct?.to && direct?.data) return direct;
    for (const call of action?.calls || []) {
      const tx = call?.transactionSubmissionData;
      if (tx?.to && tx?.data) return tx;
    }
  }
  return null;
}

async function fetchOpenSeaRawTx(config, wallet, logger) {
  if (!config.openSeaJwt && !config.openSeaApiKey) {
    logger.warn(
      "OpenSea raw tx skipped; OPENSEA_JWT or OPENSEA_API_KEY missing",
    );
    return null;
  }

  const headers = {
    "content-type": "application/json",
    "x-signed-query": "false",
    "x-app-id": "opensea-web",
    "user-agent": "Mozilla/5.0 hitamlegam-evm-mint-bot",
  };
  if (config.openSeaApiKey) headers["x-api-key"] = config.openSeaApiKey;
  if (config.openSeaJwt) headers.authorization = `Bearer ${config.openSeaJwt}`;

  const body = {
    operationName: "MintActionTimelineQuery",
    query: MINT_ACTION_TIMELINE_QUERY,
    variables: {
      address: wallet.address,
      fromAssets: [],
      toAssets: [assetQuantity(config)],
      recipient: wallet.address,
      capabilities: { supportsEIP1559: true },
    },
  };

  const response = await fetch(OPENSEA_GQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    logger.warn("OpenSea raw tx fetch failed", { status: response.status });
    return null;
  }

  const json = await response.json();
  const raw = extractRawTx(json);
  if (!raw) {
    const errors = json?.data?.swap?.errors || [];
    logger.info("OpenSea raw tx not released yet", {
      errors: errors.map((item) => item.__typename).join(","),
    });
    return null;
  }

  logger.info("OpenSea raw tx obtained", {
    to: raw.to,
    chain: raw.chain?.identifier,
  });
  return {
    to: raw.to,
    data: raw.data,
    value: BigInt(raw.value || 0),
    route: "opensea-raw",
  };
}

module.exports = { fetchOpenSeaRawTx };
