/**
 * @module chatArchiveReader
 *
 * Handles two read-only chat archive services, dispatched by `service` field:
 *
 *  - "readAll"        : Read a full chat session (messages + descriptor) from an NDJSON file.
 *                       Used when a user opens a past chat session.
 *
 *  - "listTimestamps" : Return a sorted list of saved chat archives with metadata.
 *                       Used to populate the sidebar chat list in the UI.
 */

const readline = require("readline");
const fs  = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { CHAT_DB_DIR, META_DB_FILE, toSafeNdjsonName, loadMetaDB, safeListNdjson } = require("./chatArchiveUtils");

exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION:  "Execution failed",
  NOT_FOUND:  "File not found",
};

/**
 * Main entry point — dispatches to the correct read operation
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  const service = String(jsonReq?.service || "");

  if (service === "readAll")         return _readAll(jsonReq);
  if (service === "listTimestamps")  return _listTimestamps(jsonReq);

  return { result: false, reason: exports.REASONS.VALIDATION };
};

// ─── readAll ────────────────────────────────────────────────────────────────

async function _readAll(jsonReq) {
  if (!jsonReq?.chat_filename || typeof jsonReq.chat_filename !== "string") {
    LOG.error(`chatArchiveReader/readAll: validation failed for ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  try {
    const safeName    = toSafeNdjsonName(jsonReq.chat_filename);
    const chatFilePath = path.join(CHAT_DB_DIR, safeName);

    if (!fs.existsSync(chatFilePath) || !fs.statSync(chatFilePath).isFile()) {
      return { result: false, reason: exports.REASONS.NOT_FOUND };
    }

    const messageObjects = await _readNdjsonAsArray(chatFilePath);
    const metadataDB     = await loadMetaDB(META_DB_FILE);
    const meta           = metadataDB[safeName] || {};

    const descriptor = {
      type:            "descriptor",
      created_on:      meta.created_on      || null,
      last_updated_on: meta.last_updated_on || null,
      chat_filename:   safeName,
      ai_app:          meta.ai_app          || null,
      chatsession_id:  meta.chatsession_id  ?? null,
      title:           meta.title           || null
    };

    const combined = [descriptor, ...messageObjects];
    return { result: true, filepath: chatFilePath, objects: combined, count: combined.length };

  } catch (error) {
    LOG.error(`chatArchiveReader/readAll: execution error: ${error?.stack || error}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
}

// ─── listTimestamps ──────────────────────────────────────────────────────────

async function _listTimestamps(jsonReq) {
  const aiApp = String(
    jsonReq?.ai_app ?? jsonReq?.app ?? jsonReq?.view ?? jsonReq?.viewid ?? ""
  ).trim();

  if (!aiApp) {
    LOG.error("chatArchiveReader/listTimestamps: ai_app is required");
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  if (jsonReq.prefix     != null && typeof jsonReq.prefix     !== "string") return { result: false, reason: exports.REASONS.VALIDATION };
  if (jsonReq.pattern    != null && typeof jsonReq.pattern    !== "string") return { result: false, reason: exports.REASONS.VALIDATION };
  if (jsonReq.caseInsensitive != null && typeof jsonReq.caseInsensitive !== "boolean") return { result: false, reason: exports.REASONS.VALIDATION };

  try {
    const metadataDB   = await loadMetaDB(META_DB_FILE);
    const existingFiles = new Set(await safeListNdjson(CHAT_DB_DIR));

    const rawPrefix     = (jsonReq.prefix ?? jsonReq.pattern ?? "").toString();
    const ci            = !!jsonReq.caseInsensitive;
    const desiredPrefix = ci ? rawPrefix.toLowerCase() : rawPrefix;

    const filtered = Object.keys(metadataDB).filter(name => {
      if (!existingFiles.has(name)) return false;
      if ((metadataDB[name]?.ai_app || "") !== aiApp) return false;
      if (!desiredPrefix) return true;
      return (ci ? name.toLowerCase() : name).startsWith(desiredPrefix);
    });

    const files = filtered
      .map(name => {
        const m  = metadataDB[name] || {};
        const ts = m.last_updated_on || m.created_on || null;
        return { chat_filename: name, title: m.title || null, chatsession_id: m.chatsession_id ?? null, ts, source: ts ? "meta" : null };
      })
      .sort((a, b) => {
        if (!a.ts && !b.ts) return 0;
        if (!a.ts) return 1;
        if (!b.ts) return -1;
        return a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0);
      });

    return { result: true, dir: path.resolve(CHAT_DB_DIR), files, count: files.length };

  } catch (error) {
    LOG.error(`chatArchiveReader/listTimestamps: execution error: ${error?.stack || error}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _readNdjsonAsArray(filePath) {
  const fileHandle = await fsp.open(filePath, "r");
  const messages   = [];
  try {
    const rl = readline.createInterface({
      input: fileHandle.createReadStream({ encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      const trimmed = (line || "").trim();
      if (!trimmed) continue;
      try { messages.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
    }
    return messages;
  } finally {
    await fileHandle.close();
  }
}
