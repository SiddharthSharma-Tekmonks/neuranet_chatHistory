/**
 * @module chatArchiveAppender
 *
 * This service **appends a new chat message** to an existing `.ndjson` chat archive
 * file and **updates the chat metadata record** stored in `chat_meta.json`.
 *
 * It is called whenever the user or assistant sends a new message in an ongoing chat.
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
const fs = require("fs");
const fsp = require("fs/promises");

// Default paths (relative to backend root)
const DEFAULT_APP_ROOT = path.resolve(__dirname, "../../../");
const CHAT_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "chatarchive_db");
const META_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "db");
const META_DB_FILE = path.join(META_DB_DIR, "chat_meta.json");

exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION: "Execution failed"
};

/**
 * Append a message to an NDJSON chat file and update metadata
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  if (!validateRequest(jsonReq)) {
    LOG.error(`chatArchiveAppender: Validation failure. Incoming: ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  // Extract request fields
  const { role, message, chat_filename, ai_app, chatsession_id, files, thoughts, thoughts_mime } = jsonReq;
  const nowISO = new Date().toISOString();

  try {
    // Ensure directories exist (create if missing)
    await ensureDir(CHAT_DB_DIR);
    await ensureDir(META_DB_DIR);

    // Determine the target NDJSON file path
    const safeName = toSafeNdjsonName(chat_filename);
    const filePath = path.join(CHAT_DB_DIR, safeName);
    const isNewFile = !fs.existsSync(filePath);

    // Create empty file if it doesn't exist (messages only, no descriptor)
    if (isNewFile) {
      await fsp.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
    }

    // Build message object to append
    const msgObj = {
      type: "message",
      role: String(role),              // "user" | "assistant"
      message: message,
      ts: nowISO
    };

    // Include files metadata if provided (for user messages with attachments)
    if (files && Array.isArray(files) && files.length > 0) {
      msgObj.files = files;
    }

    // Include AI thoughts if provided (for assistant messages with reasoning)
    if (thoughts && role === "assistant") {
      msgObj.thoughts = String(thoughts);
      msgObj.thoughts_mime = thoughts_mime || "text/markdown";
    }

    // Append JSON line to NDJSON file
    let messageAppended = false;
    try {
      await fsp.appendFile(
        filePath,
        JSON.stringify(msgObj) + "\n",
        { encoding: "utf8", mode: 0o600 }
      );
      messageAppended = true;
      LOG.debug(`chatArchiveAppender: message appended to ${filePath}`);
    } catch (appendErr) {
      LOG.error(`chatArchiveAppender: failed to append message to ${filePath}: ${appendErr?.message}`);
      throw appendErr;
    }

    /**
     * ---- Update metadata record (stored in chat_meta.json) ----
     */
    try {
      const metaDB = await loadMetaDB(META_DB_FILE);
      const existingMetadata = metaDB[safeName] || null;

      const metaRecord = existingMetadata ? { ...existingMetadata } : {
        chat_filename: safeName,
        created_on: nowISO,                              // new record initialization
        title: buildTitleFromMessage(message),           // auto-generate title from first message
        ai_app: ai_app || null,
        chatsession_id: chatsession_id ?? null
      };

      // Always refresh last_updated_on
      metaRecord.last_updated_on = nowISO;

      // Backfill fields if provided later (fixes partial creation cases)
      if (!metaRecord.ai_app && ai_app) metaRecord.ai_app = ai_app;
      if (metaRecord.chatsession_id == null && chatsession_id != null)
        metaRecord.chatsession_id = chatsession_id;

      // If title was blank and message exists, regenerate a title
      if ((!metaRecord.title || !String(metaRecord.title).trim()) && message) {
        metaRecord.title = buildTitleFromMessage(message);
      }

      // Persist metadata atomically
      metaDB[safeName] = metaRecord;
      await saveMetaDBAtomic(META_DB_FILE, metaDB);

      LOG.info(`chatArchiveAppender: wrote message to ${filePath}; meta updated (newFile=${isNewFile})`);

      return {
        result: true,
        filepath: filePath,
        descriptorAdded: false,  // descriptor is added only when reading history
        metaUpdated: true
      };

    } catch (metaErr) {
      // ROLLBACK: Remove appended message if metadata update failed
      if (messageAppended) {
        try {
          LOG.warn(`chatArchiveAppender: metadata update failed, rolling back message append: ${metaErr?.message}`);
          await _removeLastLine(filePath);
          LOG.info(`chatArchiveAppender: successfully rolled back message append`);
        } catch (rollbackErr) {
          LOG.error(`chatArchiveAppender: CRITICAL - failed to rollback message append: ${rollbackErr?.message}`);
          LOG.error(`chatArchiveAppender: File ${filePath} may be in inconsistent state`);
        }
      }
      throw metaErr;
    }

  } catch (err) {
    LOG.error(`chatArchiveAppender: execution error: ${err?.stack || err}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};

// ------------------------------------------------------------------------
// Helper Functions
// ------------------------------------------------------------------------

/** Validate request body to ensure required fields exist */
function validateRequest(req) {
  if (!req || typeof req !== "object") return false;
  const { role, message, chat_filename } = req;
  if (!chat_filename || typeof chat_filename !== "string") return false;
  if (message == null) return false;
  if (!role || (role !== "user" && role !== "assistant")) return false;
  return true;
}

/** Ensure directory exists and create if missing */
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Convert a raw filename into a safe `.ndjson` filename */
function toSafeNdjsonName(name) {
  let base = path.basename(String(name).trim());
  base = base.replace(/\.[^/.]+$/, "");       // remove existing extensions
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) base = "archive";
  return `${base}.ndjson`;
}

/**
 * Build a clean fallback chat title based on the first message text
 * Attempts smart truncation at word boundaries up to 40 chars
 */
function buildTitleFromMessage(message, maxLen = 40) {
  if (!message) return "Chat";
  const cleaned = String(message).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Chat";
  if (cleaned.length <= maxLen) return cleaned;

  const chunk = cleaned.slice(0, maxLen);
  const lastSpace = chunk.lastIndexOf(" ");
  if (lastSpace > 0) return chunk.slice(0, lastSpace).trim() + "...";
  return chunk.slice(0, 15).trim() + "...";
}

// ----- Metadata DB handling -----

/** Load metadata JSON file safely */
async function loadMetaDB(file) {
  try {
    const data = await fsp.readFile(file, "utf8");
    const obj = JSON.parse(data);
    return (obj && typeof obj === "object") ? obj : {};
  } catch {
    return {};
  }
}

/** Write metadata atomically to avoid corruption during crashes */
async function saveMetaDBAtomic(file, obj) {
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, file);
}

/**
 * Remove the last line from an NDJSON file (for rollback on error)
 * Used when message append succeeds but metadata update fails
 */
async function _removeLastLine(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content.split("\n");

    // Remove last line (which is empty after split) and the actual last message
    if (lines.length > 1) {
      lines.pop(); // Remove empty string at end from final \n
    }
    if (lines.length > 0) {
      lines.pop(); // Remove the last message
    }

    // Write back without the last message
    const newContent = lines.join("\n");
    if (lines.length > 0) {
      // Ensure file ends with newline
      await fsp.writeFile(filePath, newContent + "\n", { encoding: "utf8", mode: 0o600 });
    } else {
      // If no messages left, truncate to empty
      await fsp.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
    }

  } catch (err) {
    LOG.error(`_removeLastLine: failed to remove last line from ${filePath}: ${err?.message}`);
    throw err;
  }
}
