// sendUploadedFileList.js
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const neuranetConstants = require("../lib/neuranetconstants.js");

const LOG = global.LOG || console;

// Use neuranet constants for reliable path resolution across execution contexts
const APPROOT = neuranetConstants.APPROOT;
const UPLOAD_DB_DIR = path.join(APPROOT, "Aiapp", "uploaded_files_db");

exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION: "Execution failed"
};

/**
 * Return list of uploaded files for a chat.
 *
 * Expected:
 *   jsonReq.chat_filename = "<same NDJSON base name you used originally>"
 *
 * Response:
 *   { result: true, files: [ { name, size, mtime, stored_filename, download_id? } ] }
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  if (!validateListRequest(jsonReq)) {
    LOG.error(`sendUploadedFileList: Validation failure. Incoming: ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  const { chat_filename } = jsonReq;

  try {
    const chatFolderName = toSafeFolderName(chat_filename);
    const chatUploadDir  = path.join(UPLOAD_DB_DIR, chatFolderName);

    // If folder doesn't exist, just return empty list
    let files = [];
    if (fs.existsSync(chatUploadDir)) {
      const names = await fsp.readdir(chatUploadDir);
      files = await Promise.all(
        names.map(async (storedFilename) => {
          const fullPath = path.join(chatUploadDir, storedFilename);
          const stat = await fsp.stat(fullPath);
          return {
            stored_filename: storedFilename,
            // Optional: original name could be parsed from prefix, or just use stored name
            display_name: storedFilename.replace(/^\d+__/, ""), // strip timestamp prefix
            size: stat.size,
            mtime: stat.mtime.toISOString()
          };
        })
      );
    }

    return {
      result: true,
      chat_filename,
      files
    };

  } catch (err) {
    LOG.error(`sendUploadedFileList: execution error: ${err?.stack || err}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};

// ------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------

function validateListRequest(req) {
  if (!req || typeof req !== "object") return false;
  const { chat_filename } = req;
  if (!chat_filename || typeof chat_filename !== "string") return false;
  return true;
}

function toSafeFolderName(name) {
  let base = path.basename(String(name).trim());
  base = base.replace(/\.[^/.]+$/, "");       // remove extension
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) base = "archive";
  return base;
}
