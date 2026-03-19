/**
 * @module manageChatHistory
 *
 * Provides update and delete operations for stored chat history.
 *
 * Supported actions (via `service` field):
 *  - updateTitle : Update a chat's display title and last_updated timestamp
 *  - delete      : Remove both the NDJSON chat file and its metadata record
 */

const fs  = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { CHAT_DB_DIR, META_DB_FILE, toSafeNdjsonName, loadMetaDB, saveMetaDBAtomic } = require("./chatArchiveUtils");

exports.REASONS = {
  VALIDATION: "Validation failed",
  NOT_FOUND:  "Record not found",
  FORBIDDEN:  "ai_app mismatch",
  EXECUTION:  "Execution failed"
};

exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  try {
    const serviceName      = String(jsonReq?.service || "");
    const safeChatFilename = toSafeNdjsonName(jsonReq?.chat_filename);
    const aiAppId          = String(jsonReq?.ai_app || "").trim();

    if (!["updateTitle", "delete"].includes(serviceName) || !safeChatFilename || !aiAppId) {
      return { result: false, reason: exports.REASONS.VALIDATION };
    }

    const metadataDB    = await loadMetaDB(META_DB_FILE);
    const chatMetaEntry = metadataDB[safeChatFilename];

    if (!chatMetaEntry)                               return { result: false, reason: exports.REASONS.NOT_FOUND };
    if ((chatMetaEntry.ai_app || "") !== aiAppId)     return { result: false, reason: exports.REASONS.FORBIDDEN };

    if (serviceName === "updateTitle") {
      const newTitle = String(jsonReq?.title || "").trim();
      if (!newTitle) return { result: false, reason: exports.REASONS.VALIDATION };

      chatMetaEntry.title           = newTitle;
      chatMetaEntry.last_updated_on = new Date().toISOString();
      metadataDB[safeChatFilename]  = chatMetaEntry;
      await saveMetaDBAtomic(META_DB_FILE, metadataDB);

      return { result: true, action: "updateTitle", chat_filename: safeChatFilename, ai_app: aiAppId, title: chatMetaEntry.title, last_updated_on: chatMetaEntry.last_updated_on };
    }

    if (serviceName === "delete") {
      const chatFilePath = path.join(path.resolve(CHAT_DB_DIR), safeChatFilename);
      try {
        if (fs.existsSync(chatFilePath) && fs.statSync(chatFilePath).isFile()) await fsp.unlink(chatFilePath);
      } catch (unlinkError) {
        LOG.warn(`manageChatHistory: unlink failed for ${chatFilePath}: ${unlinkError?.message || unlinkError}`);
      }

      delete metadataDB[safeChatFilename];
      await saveMetaDBAtomic(META_DB_FILE, metadataDB);

      return { result: true, action: "delete", chat_filename: safeChatFilename, ai_app: aiAppId, removed_file: true, removed_meta: true };
    }

    return { result: false, reason: exports.REASONS.VALIDATION };

  } catch (error) {
    LOG.error(`manageChatHistory: execution error: ${error?.stack || error}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};
