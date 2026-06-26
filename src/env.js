const fs = require('fs');
const path = require('path');

function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv(file = process.env.DOTENV_PATH || '.env') {
  const envPath = path.resolve(process.cwd(), file);
  const fileEnv = fs.existsSync(envPath) ? parseEnvText(fs.readFileSync(envPath, 'utf8')) : {};
  return { ...fileEnv, ...process.env };
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value));
}

function numberValue(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

module.exports = { parseEnvText, loadEnv, boolValue, numberValue };
