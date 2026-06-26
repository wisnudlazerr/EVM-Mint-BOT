#!/usr/bin/env node
/*
 * Deep OpenSea analyzer.
 * Opens a real browser page, watches network requests, and reports GraphQL operations,
 * auth presence, raw transaction hints, stage/drop hints, and likely blockers.
 * Does not sign transactions and does not broadcast.
 */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../src/env');
const { createLogger } = require('../src/logger');

function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization|cookie|token|key/i.test(key)) out[key] = value ? '[REDACTED]' : value;
    else out[key] = value;
  }
  return out;
}

function findHints(obj, found = { rawTx: false, stages: [], errors: [], operationNames: new Set() }) {
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) {
    for (const item of obj) findHints(item, found);
    return found;
  }
  if (obj.operationName) found.operationNames.add(obj.operationName);
  if (obj.to && obj.data && typeof obj.data === 'string' && obj.data.startsWith('0x')) found.rawTx = true;
  for (const [key, value] of Object.entries(obj)) {
    if (/stage/i.test(key) && value) found.stages.push({ key, value: typeof value === 'object' ? JSON.stringify(value).slice(0, 240) : String(value).slice(0, 240) });
    if (/error|message|reason/i.test(key) && value) found.errors.push({ key, value: String(value).slice(0, 240) });
    if (value && typeof value === 'object') findHints(value, found);
  }
  return found;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error('Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium');
  }

  const env = loadEnv();
  const logger = createLogger();
  const url = env.OPENSEA_DROP_URL || (env.OPENSEA_COLLECTION_SLUG ? `https://opensea.io/collection/${env.OPENSEA_COLLECTION_SLUG}` : '');
  if (!url) throw new Error('Missing OPENSEA_DROP_URL or OPENSEA_COLLECTION_SLUG');

  const headless = !/^false$/i.test(String(env.HEADLESS || 'true'));
  const outDir = path.resolve(process.cwd(), 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `opensea-analysis-${Date.now()}.json`);

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const report = { url, headless, startedAt: new Date().toISOString(), graphql: [], hints: { rawTx: false, stages: [], errors: [], operationNames: [] } };

  page.on('request', (req) => {
    const reqUrl = req.url();
    if (!/graphql|gql\.opensea/i.test(reqUrl)) return;
    let postData = null;
    try { postData = req.postDataJSON(); } catch { postData = req.postData(); }
    const headers = redactHeaders(req.headers());
    const op = postData?.operationName || null;
    report.graphql.push({ direction: 'request', url: reqUrl, method: req.method(), operationName: op, headers, postDataPreview: JSON.stringify(postData).slice(0, 1000) });
    findHints(postData, report.hints);
  });

  page.on('response', async (res) => {
    const reqUrl = res.url();
    if (!/graphql|gql\.opensea/i.test(reqUrl)) return;
    let json = null;
    try { json = await res.json(); } catch { return; }
    report.graphql.push({ direction: 'response', url: reqUrl, status: res.status(), preview: JSON.stringify(json).slice(0, 2000) });
    findHints(json, report.hints);
  });

  logger.info('opening OpenSea page', { url, headless });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(Number(env.ANALYZE_WAIT_MS || 15000));
  report.finishedAt = new Date().toISOString();
  report.hints.operationNames = [...report.hints.operationNames];
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  await browser.close();

  console.log(JSON.stringify({
    outFile,
    graphqlEvents: report.graphql.length,
    operationNames: report.hints.operationNames,
    rawTxHintSeen: report.hints.rawTx,
    stageHints: report.hints.stages.slice(0, 10),
    errors: report.hints.errors.slice(0, 10),
  }, null, 2));
}

main().catch((error) => { console.error(`ERROR ${error.message}`); process.exitCode = 1; });
