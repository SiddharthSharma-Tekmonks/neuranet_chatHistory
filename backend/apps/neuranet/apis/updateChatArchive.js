/**
 * @module manageChatHistory
 *
 * This service provides **update** and **delete** operations for stored chat history
 * in the Neuranet AI application. Chat sessions are stored as `.ndjson` message files,
 * and their metadata (title, timestamps, ai_app, chatsession_id) is stored in a JSON
 * metadata database (`chat_meta.json`).
 *
 * Supported actions:
 *  - updateTitle : Update a chat's display title and last_updated timestamp
 *  - delete      : Remove both the NDJSON chat file and its metadata record
 *
 * The service enforces that:
 *  - The requested chat file must exist in metadata
 *  - The ai_app value must match the owner application (security check)
 *  - All operations are atomic and safe against partial failure
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");


// Default filesystem locations (relative to app root)
const DEFAULT_APP_ROOT = path.resolve(__dirname, "../../../");
const CHAT_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "chatarchive_db");
const META_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "db");
const META_DB_FILE = path.join(META_DB_DIR, "chat_meta.json");

// Standardized error codes returned to the frontend
exports.REASONS = {
  VALIDATION: "Validation failed",
  NOT_FOUND:  "Record not found",
  FORBIDDEN:  "ai_app mismatch",
  EXECUTION:  "Execution failed"
};

/**
 * Main service entry point
 * Determines which action to perform: updateTitle or delete
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  try {
    const serviceName = String(jsonReq?.service || "");

    // Only allow two known operations
    if (!["updateTitle", "delete"].includes(serviceName)) {
      return { result: false, reason: exports.REASONS.VALIDATION };
    }

    // Normalize and validate required fields
    const safeChatFilename = toSafeNdjsonName(jsonReq?.chat_filename);
    const aiAppId          = sanitizeStr(jsonReq?.ai_app);

    if (!safeChatFilename || !aiAppId) {
      return { result: false, reason: exports.REASONS.VALIDATION };
    }

    // Load metadata DB and locate record
    const metadataDB = await loadMetaDB(META_DB_FILE);
    const chatMetaEntry = metadataDB[safeChatFilename];

    if (!chatMetaEntry) {
      return { result: false, reason: exports.REASONS.NOT_FOUND };
    }

    // Security check — ensure user actions are limited to their own app context
    if ((chatMetaEntry.ai_app || "") !== aiAppId) {
      return { result: false, reason: exports.REASONS.FORBIDDEN };
    }

    /**
     * ===== UPDATE TITLE =====
     */
    if (serviceName === "updateTitle") {
      const newTitle = sanitizeStr(jsonReq?.title);
      if (!newTitle) return { result: false, reason: exports.REASONS.VALIDATION };

      // Update metadata entry
      chatMetaEntry.title = newTitle;
      chatMetaEntry.last_updated_on = new Date().toISOString();

      metadataDB[safeChatFilename] = chatMetaEntry;
      await saveMetaDBAtomic(META_DB_FILE, metadataDB);   // Safe write operation

      return {
        result: true,
        action: "updateTitle",
        chat_filename: safeChatFilename,
        ai_app: aiAppId,
        title: chatMetaEntry.title,
        last_updated_on: chatMetaEntry.last_updated_on
      };
    }

    /**
     * ===== DELETE CHAT HISTORY =====
     * Remove both the NDJSON file (messages) and its metadata record
     */
    if (serviceName === "delete") {
      const chatArchiveDir = path.resolve(CHAT_DB_DIR);
      const chatFilePath   = path.join(chatArchiveDir, safeChatFilename);

      // Attempt to remove associated NDJSON file
      try {
        if (fs.existsSync(chatFilePath) && fs.statSync(chatFilePath).isFile()) {
          await fsp.unlink(chatFilePath);
        }
      } catch (unlinkError) {
        // Do not abort — file removal failure should not block metadata removal
        LOG.warn(`manageChatHistory: unlink failed for ${chatFilePath}: ${unlinkError?.message || unlinkError}`);
      }

      // Remove metadata entry from DB
      delete metadataDB[safeChatFilename];
      await saveMetaDBAtomic(META_DB_FILE, metadataDB);

      return {
        result: true,
        action: "delete",
        chat_filename: safeChatFilename,
        ai_app: aiAppId,
        removed_file: true,
        removed_meta: true
      };
    }

    return { result: false, reason: exports.REASONS.VALIDATION };

  } catch (error) {
    LOG.error(`manageChatHistory: execution error: ${error?.stack || error}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};



// --------------- Helper Functions ---------------

/** Safely trim and convert input to a clean string */
function sanitizeStr(value) {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * Convert any user-supplied name into a safe `.ndjson` filename
 * Prevents path traversal, shell injection, and invalid filenames
 */
function toSafeNdjsonName(rawName) {
  let baseName = path.basename(String(rawName || "").trim());
  baseName = baseName.replace(/\.[^/.]+$/, ""); // strip extension
  baseName = baseName.replace(/[^A-Za-z0-9._-]/g, "_"); // enforce safe characters
  if (!baseName) return "";
  return `${baseName}.ndjson`;
}

/** Load metadata database safely */
async function loadMetaDB(filePath) {
  try {
    const fileContents = await fsp.readFile(filePath, "utf8");
    const parsedObject = JSON.parse(fileContents);
    return (parsedObject && typeof parsedObject === "object") ? parsedObject : {};
  } catch {
    return {};
  }
}

/**
 * Write metadata safely using atomic replace strategy
 * - Writes to a temporary file first to prevent corruption
 * - Renames the file only after successful write
 */
async function saveMetaDBAtomic(filePath, metadataObject) {
  const metaDir = path.dirname(filePath);
  await fsp.mkdir(metaDir, { recursive: true, mode: 0o700 });

  const tempFilePath = filePath + ".tmp";
  await fsp.writeFile(
    tempFilePath,
    JSON.stringify(metadataObject, null, 2),
    { encoding: "utf8", mode: 0o600 }
  );
  await fsp.rename(tempFilePath, filePath);
}
