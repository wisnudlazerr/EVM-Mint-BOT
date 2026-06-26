const fs = require("fs");
const path = require("path");

function maskHex(value) {
  if (!value || typeof value !== "string") return value;
  if (/^0x[0-9a-fA-F]{16,}$/.test(value))
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  return value;
}

function maskUrl(value) {
  if (!value || typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|api/i.test(key))
        url.searchParams.set(key, "***");
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (
      pathParts.length > 1 &&
      /[A-Za-z0-9_-]{16,}/.test(pathParts[pathParts.length - 1])
    ) {
      pathParts[pathParts.length - 1] = "****";
      url.pathname = `/${pathParts.join("/")}`;
    }
    return url.toString();
  } catch {
    return value.replace(/(key|token|secret|auth)=([^&\s]+)/gi, "$1=***");
  }
}

function sanitize(value) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return maskUrl(value);
    return maskHex(value);
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/private|secret|auth|token|key/i.test(key) && typeof val === "string")
        out[key] = maskHex(maskUrl(val));
      else out[key] = sanitize(val);
    }
    return out;
  }
  return value;
}

function createLogger(options = {}) {
  const file = options.file || null;
  function write(level, message, meta = {}) {
    const row = {
      ts: new Date().toISOString(),
      level,
      message,
      ...sanitize(meta),
    };
    const suffix = Object.keys(meta).length
      ? ` ${JSON.stringify(sanitize(meta))}`
      : "";
    console.log(`[${row.ts}] ${level.toUpperCase()} ${message}${suffix}`);
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + "\n");
    }
  }
  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

module.exports = { createLogger, maskHex, maskUrl, sanitize };
