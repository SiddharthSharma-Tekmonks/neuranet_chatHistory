/**
 * @module chatArchiveUtils
 * Shared utilities for chat archive services.
 * Import from this module instead of redefining in each service file.
 */

const path = require("path");
const fsp  = require("fs/promises");

const DEFAULT_APP_ROOT = path.resolve(__dirname, "../../../");
const CHAT_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "chatarchive_db");
const META_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "db");
const META_DB_FILE = path.join(META_DB_DIR, "chat_meta.json");

/** Convert any user-supplied name into a safe `.ndjson` filename */
function toSafeNdjsonName(rawName) {
  let base = path.basename(String(rawName || "").trim());
  base = base.replace(/\.[^/.]+$/, "");
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) return "";
  return `${base}.ndjson`;
}

/** Load metadata JSON file safely, returning {} if missing or malformed */
async function loadMetaDB(filePath) {
  try {
    const data = await fsp.readFile(filePath, "utf8");
    const obj  = JSON.parse(data);
    return (obj && typeof obj === "object") ? obj : {};
  } catch {
    return {};
  }
}

/** Write metadata atomically to avoid corruption during crashes */
async function saveMetaDBAtomic(filePath, obj) {
  const metaDir = path.dirname(filePath);
  await fsp.mkdir(metaDir, { recursive: true, mode: 0o700 });
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

/** Ensure a directory exists, creating it if needed */
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** List valid `.ndjson` files in a directory, excluding hidden files */
async function safeListNdjson(directoryPath) {
  try {
    const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith(".ndjson") && !e.name.startsWith("."))
      .map(e => e.name);
  } catch {
    return [];
  }
}

module.exports = { CHAT_DB_DIR, META_DB_DIR, META_DB_FILE, toSafeNdjsonName, loadMetaDB, saveMetaDBAtomic, ensureDir, safeListNdjson };
