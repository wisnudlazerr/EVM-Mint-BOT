#!/usr/bin/env node
const { loadEnv } = require('../src/env');

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('JWT must have header.payload.signature format');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(payload, 'base64').toString('utf8');
  return JSON.parse(json);
}

function main() {
  const env = loadEnv();
  const jwt = env.OPENSEA_JWT;
  if (!jwt) throw new Error('Missing OPENSEA_JWT in .env');

  const payload = decodeJwt(jwt);
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  const left = exp ? exp - now : null;

  console.log(JSON.stringify({
    ok: !exp || left > 0,
    subject: payload.sub || null,
    issuer: payload.iss || null,
    issuedAt: iat ? new Date(iat * 1000).toISOString() : null,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    secondsLeft: left,
    minutesLeft: left === null ? null : Math.floor(left / 60),
  }, null, 2));

  if (exp && left <= 0) throw new Error('OPENSEA_JWT is expired. Re-copy a fresh Bearer token from OpenSea.');
  if (exp && left < 600) console.warn('WARN OPENSEA_JWT expires in <10 minutes. Refresh before FCFS war.');
}

try { main(); } catch (error) { console.error(`ERROR ${error.message}`); process.exitCode = 1; }
