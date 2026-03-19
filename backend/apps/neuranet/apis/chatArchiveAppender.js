/**
 * @module chatArchiveAppender
 *
 * Appends a new chat message to an existing `.ndjson` chat archive file
 * and updates the metadata record in `chat_meta.json`.
 *
 * Responsibilities:
 *  1. Validate request payload (role, message, filename, etc.)
 *  2. Ensure storage directories exist
 *  3. Append new message (NDJSON format: one message per line)
 *  4. Create metadata entry if this is a new chat
 *  5. Update timestamp + optional title + ai_app + session id
 *  6. Perform atomic JSON metadata updates to avoid corruption
 */

const path = require("path");
const fs   = require("fs");
const fsp  = require("fs/promises");
const { CHAT_DB_DIR, META_DB_FILE, toSafeNdjsonName, loadMetaDB, saveMetaDBAtomic, ensureDir } = require("./chatArchiveUtils");

const META_DB_DIR = require("./chatArchiveUtils").META_DB_DIR;

exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION:  "Execution failed"
};

/**
 * Append a message to an NDJSON chat file and update metadata
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  if (!_validateRequest(jsonReq)) {
    LOG.error(`chatArchiveAppender: Validation failure. Incoming: ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  const { role, message, chat_filename, ai_app, chatsession_id, files, thoughts, thoughts_mime } = jsonReq;
  const nowISO = new Date().toISOString();

  try {
    await ensureDir(CHAT_DB_DIR);
    await ensureDir(META_DB_DIR);

    const safeName  = toSafeNdjsonName(chat_filename);
    const filePath  = path.join(CHAT_DB_DIR, safeName);
    const isNewFile = !fs.existsSync(filePath);

    if (isNewFile) {
      await fsp.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
    }

    const msgObj = { type: "message", role: String(role), message, ts: nowISO };

    if (files && Array.isArray(files) && files.length > 0) msgObj.files = files;

    if (thoughts && role === "assistant") {
      msgObj.thoughts      = String(thoughts);
      msgObj.thoughts_mime = thoughts_mime || "text/markdown";
    }

    let messageAppended = false;
    try {
      await fsp.appendFile(filePath, JSON.stringify(msgObj) + "\n", { encoding: "utf8", mode: 0o600 });
      messageAppended = true;
      LOG.debug(`chatArchiveAppender: message appended to ${filePath}`);
    } catch (appendErr) {
      LOG.error(`chatArchiveAppender: failed to append message to ${filePath}: ${appendErr?.message}`);
      throw appendErr;
    }

    try {
      const metaDB        = await loadMetaDB(META_DB_FILE);
      const existingMeta  = metaDB[safeName] || null;

      const metaRecord = existingMeta ? { ...existingMeta } : {
        chat_filename:  safeName,
        created_on:     nowISO,
        title:          _buildTitleFromMessage(message),
        ai_app:         ai_app || null,
        chatsession_id: chatsession_id ?? null
      };

      metaRecord.last_updated_on = nowISO;
      if (!metaRecord.ai_app && ai_app) metaRecord.ai_app = ai_app;
      if (metaRecord.chatsession_id == null && chatsession_id != null) metaRecord.chatsession_id = chatsession_id;
      if ((!metaRecord.title || !String(metaRecord.title).trim()) && message) metaRecord.title = _buildTitleFromMessage(message);

      metaDB[safeName] = metaRecord;
      await saveMetaDBAtomic(META_DB_FILE, metaDB);

      LOG.info(`chatArchiveAppender: wrote message to ${filePath}; meta updated (newFile=${isNewFile})`);
      return { result: true, filepath: filePath, descriptorAdded: false, metaUpdated: true };

    } catch (metaErr) {
      if (messageAppended) {
        try {
          LOG.warn(`chatArchiveAppender: metadata update failed, rolling back: ${metaErr?.message}`);
          await _removeLastLine(filePath);
          LOG.info(`chatArchiveAppender: rollback successful`);
        } catch (rollbackErr) {
          LOG.error(`chatArchiveAppender: CRITICAL - rollback failed: ${rollbackErr?.message}`);
        }
      }
      throw metaErr;
    }

  } catch (err) {
    LOG.error(`chatArchiveAppender: execution error: ${err?.stack || err}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _validateRequest(req) {
  if (!req || typeof req !== "object") return false;
  const { role, message, chat_filename } = req;
  if (!chat_filename || typeof chat_filename !== "string") return false;
  if (message == null) return false;
  if (!role || (role !== "user" && role !== "assistant")) return false;
  return true;
}

function _buildTitleFromMessage(message, maxLen = 40) {
  if (!message) return "Chat";
  const cleaned = String(message).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Chat";
  if (cleaned.length <= maxLen) return cleaned;
  const chunk = cleaned.slice(0, maxLen);
  const lastSpace = chunk.lastIndexOf(" ");
  if (lastSpace > 0) return chunk.slice(0, lastSpace).trim() + "...";
  return chunk.slice(0, 15).trim() + "...";
}

async function _removeLastLine(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    const lines   = content.split("\n");
    if (lines.length > 1) lines.pop(); // trailing empty string from final \n
    if (lines.length > 0) lines.pop(); // the last message line
    const newContent = lines.join("\n");
    await fsp.writeFile(
      filePath,
      lines.length > 0 ? newContent + "\n" : "",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    LOG.error(`_removeLastLine: failed for ${filePath}: ${err?.message}`);
    throw err;
  }
}
