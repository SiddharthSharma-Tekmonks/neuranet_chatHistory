/**
 * @module sendChatArchiveList
 *
 * This service returns a **list of saved chat archives** with metadata,
 * sorted by most recently updated. Each chat session corresponds to one
 * `.ndjson` file containing message history and a corresponding metadata
 * entry in `chat_meta.json`.
 *
 * This endpoint is typically used to display a sidebar list of existing
 * chat sessions (titles + timestamps) when loading the Chat UI.
 *
 * The response returns objects like:
 *   {
 *      chat_filename,
 *      title,
 *      chatsession_id,
 *      ts,        // timestamp (last_updated_on or created_on)
 *      source     // "meta" if timestamp discovered from metadata
 *   }
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// Default filesystem paths used to locate chat and metadata stores
const DEFAULT_APP_ROOT = path.resolve(__dirname, "../../../");
const CHAT_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "chatarchive_db");
const META_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "db");
const META_DB_FILE = path.join(META_DB_DIR, "chat_meta.json");

// Response-level reason codes for consistent API responses
exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION: "Execution failed",
  NOT_FOUND: "Directory not found",
  META_NOT_FOUND: "Metadata DB not found"
};

/**
 * Main entry point: returns list of chat archives for a specific ai_app
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  // Validate request structure
  if (!validate(jsonReq)) {
    LOG.error(`listTimestamps: validation failed for ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  if (jsonReq.service !== "listTimestamps") {
    return { result: false, reason: "Unknown service type" };
  }

  // ai_app field may come from multiple client formats; normalize to string
  const aiApp = String(
    jsonReq.ai_app ?? jsonReq.app ?? jsonReq.view ?? jsonReq.viewid ?? ""
  ).trim();
  if (!aiApp) {
    LOG.error("listTimestamps: ai_app is required");
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  // Support prefix search for UI filtering
  const rawPrefix = (jsonReq.prefix ?? jsonReq.pattern ?? "").toString();
  const caseInsensitive = !!jsonReq.caseInsensitive;
  const desiredPrefix = caseInsensitive ? rawPrefix.toLowerCase() : rawPrefix;

  try {
    // Load metadata describing each chat archive
    const metadataDB = await loadMetaDB(META_DB_FILE);
    const allChatFilenames = Object.keys(metadataDB);

    // Resolve actual .ndjson files on disk to avoid stale metadata entries
    const existingNdjsonFilenames = new Set(await safeListNdjson(CHAT_DB_DIR));

    /**
     * Filter chat archive names based on:
     *   - File physically exists in archive directory
     *   - Belongs to the requested ai_app context
     *   - Optional prefix match for search filtering
     */
    const filteredChatFilenames = allChatFilenames.filter(chatFilename => {
      if (!existingNdjsonFilenames.has(chatFilename)) return false;

      const chatMetaEntry = metadataDB[chatFilename] || {};
      if ((chatMetaEntry.ai_app || "") !== aiApp) return false;

      if (!desiredPrefix) return true; // no search filter applied

      const comparableFilename = caseInsensitive
        ? chatFilename.toLowerCase()
        : chatFilename;

      return comparableFilename.startsWith(desiredPrefix);
    });

    /**
     * Build response objects for each archive entry
     * Includes title, timestamp, and identifying details
     */
    let responseFiles = filteredChatFilenames.map(chatFilename => {
      const chatMetaEntry = metadataDB[chatFilename] || {};
      const timestamp =
        chatMetaEntry.last_updated_on ||
        chatMetaEntry.created_on ||
        null;

      return {
        chat_filename: chatFilename,
        title: chatMetaEntry.title || null,
        chatsession_id: chatMetaEntry.chatsession_id ?? null,
        ts: timestamp,
        source: timestamp ? "meta" : null
      };
    });

    // Sort by newest timestamp first, with null timestamps at the end
    responseFiles.sort((fileA, fileB) => {
      if (!fileA.ts && !fileB.ts) return 0;
      if (!fileA.ts) return 1;
      if (!fileB.ts) return -1;
      return fileA.ts < fileB.ts ? 1 : (fileA.ts > fileB.ts ? -1 : 0);
    });

    return {
      result: true,
      dir: path.resolve(CHAT_DB_DIR),
      files: responseFiles,
      count: responseFiles.length
    };

  } catch (error) {
    LOG.error(`listTimestamps: execution error: ${error?.stack || error}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};

// -------- helper functions --------

/**
 * Check request shape and optional field types
 */
function validate(request) {
  if (!request || typeof request !== "object") return false;
  if (request.service !== "listTimestamps") return false;
  if (request.prefix != null && typeof request.prefix !== "string") return false;
  if (request.pattern != null && typeof request.pattern !== "string") return false;
  if (request.caseInsensitive != null && typeof request.caseInsensitive !== "boolean") return false;
  return true;
}

/**
 * Safe load metadata file, returning {} if missing or corrupted
 */
async function loadMetaDB(filePath) {
  try {
    const fileContents = await fsp.readFile(filePath, "utf8");
    const parsedObject = JSON.parse(fileContents);
    return (parsedObject && typeof parsedObject === "object") ? parsedObject : {};
  } catch (_error) {
    return {};
  }
}

/**
 * List valid `.ndjson` message archive files in the directory.
 * Excludes hidden files, directories, and other file types.
 */
async function safeListNdjson(directoryPath) {
  try {
    const directoryEntries = await fsp.readdir(directoryPath, { withFileTypes: true });
    return directoryEntries
      .filter(entry =>
        entry.isFile() &&
        entry.name.endsWith(".ndjson") &&
        !entry.name.startsWith(".")
      )
      .map(entry => entry.name);
  } catch (_error) {
    return [];
  }
}
