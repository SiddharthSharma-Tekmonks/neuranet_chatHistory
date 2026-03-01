/**
 * @module sendChatHistory
 *
 * This service reads a complete chat history from an NDJSON file stored on disk,
 * reconstructs the messages into an array of objects, and prepends a descriptor
 * object that contains metadata such as title, timestamps, ai_app, etc.
 *
 * NDJSON = "Newline Delimited JSON"
 * Each line = one message object, allowing streaming and efficient reading.
 *
 * The final response sent to the frontend is an array:
 *   [ {descriptor}, {message1}, {message2}, ... ]
 *
 * Used when a user opens a past chat session to fully restore all messages.
 */

const readline = require("readline");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");


// Default storage locations relative to backend root
const DEFAULT_APP_ROOT = path.resolve(__dirname, "../../../");
const CHAT_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "chatarchive_db");
const META_DB_DIR  = path.join(DEFAULT_APP_ROOT, "apps", "neuranet", "Aiapp", "db");
const META_DB_FILE = path.join(META_DB_DIR, "chat_meta.json");

// Standardized return codes used to signal error conditions
exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION: "Execution failed",
  NOT_FOUND: "File not found",
};

/**
 * Main service entry point
 * Reads and returns an entire chat session + metadata descriptor
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  // Validate shape and fields of incoming request
  if (!validate(jsonReq)) {
    LOG.error(`chatArchiveReadAll: validation failed for ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  if (jsonReq.service !== "readAll") {
    return { result: false, reason: "Unknown service type" };
  }

  try {
    // Build full path to target archive file
    const chatArchiveDir = path.resolve(CHAT_DB_DIR);
    const safeChatFilename = toSafeNdjsonName(jsonReq.chat_filename);
    const chatFilePath = path.join(chatArchiveDir, safeChatFilename);

    // Ensure the NDJSON file actually exists before reading
    if (!fs.existsSync(chatFilePath) || !fs.statSync(chatFilePath).isFile()) {
      return { result: false, reason: exports.REASONS.NOT_FOUND };
    }

    // 1) Load all chat messages into an array
    const messageObjects = await readNdjsonAsArray(chatFilePath);

    // 2) Read metadata (title, timestamps, ai_app, etc.)
    const metadataDB = await loadMetaDB(META_DB_FILE);
    const chatMetaEntry = metadataDB[safeChatFilename] || {};

    // Descriptor prepended to message history
    const descriptorObject = {
      type: "descriptor",
      created_on: chatMetaEntry.created_on || null,
      last_updated_on: chatMetaEntry.last_updated_on || null,
      chat_filename: safeChatFilename,
      ai_app: chatMetaEntry.ai_app || null,
      chatsession_id: chatMetaEntry.chatsession_id ?? null,
      title: chatMetaEntry.title || null
    };

    // Combine metadata object + all messages in the correct order
    const combinedObjects = [descriptorObject, ...messageObjects];

    return {
      result: true,
      filepath: chatFilePath,
      objects: combinedObjects,
      count: combinedObjects.length
    };

  } catch (error) {
    LOG.error(`chatArchiveReadAll: execution error: ${error?.stack || error}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};

// -------- Helper Functions --------

/**
 * Validate that the request contains the required fields
 */
function validate(request) {
  if (!request || typeof request !== "object") return false;
  if (request.service !== "readAll") return false;
  if (!request.chat_filename || typeof request.chat_filename !== "string") return false;
  return true;
}

/**
 * Convert any supplied filename into a safe `.ndjson` filename,
 * removing unsafe characters, enforcing valid structure, preventing path traversal.
 */
function toSafeNdjsonName(rawName) {
  let baseName = path.basename(String(rawName).trim());
  baseName = baseName.replace(/\.[^/.]+$/, "");     // remove extension
  baseName = baseName.replace(/[^A-Za-z0-9._-]/g, "_"); // enforce safe chars
  if (!baseName) baseName = "archive";
  return `${baseName}.ndjson`;
}

/**
 * Reads NDJSON file line-by-line using streaming.
 * Each line is parsed into a JSON object and stored in the output array.
 * Malformed lines are skipped to ensure robust reading.
 */
async function readNdjsonAsArray(filePath) {
  const fileHandle = await fsp.open(filePath, "r");
  const messages = [];

  try {
    const readStream = fileHandle.createReadStream({ encoding: "utf8" });
    const readlineInterface = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity   // Treat CRLF as a single newline, supports Win/Unix consistency
    });

    for await (const line of readlineInterface) {
      const trimmedLine = (line || "").trim();
      if (!trimmedLine) continue;

      try {
        const parsedObject = JSON.parse(trimmedLine);
        messages.push(parsedObject);
      } catch {
        // Skip corrupted lines without failing whole operation
      }
    }
    return messages;

  } finally {
    await fileHandle.close();  // Always close file handle safely
  }
}

/**
 * Load metadata database from disk,
 * returning an empty object if the database is missing or malformed.
 */
async function loadMetaDB(filePath) {
  try {
    const fileContents = await fsp.readFile(filePath, "utf8");
    const parsedObject = JSON.parse(fileContents);
    return (parsedObject && typeof parsedObject === "object") ? parsedObject : {};
  } catch {
    return {};
  }
}
