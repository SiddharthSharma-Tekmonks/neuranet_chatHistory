// uploadChatFile.js
const path = require("path");
const fsp  = require("fs/promises");
const neuranetConstants = require("../lib/neuranetconstants.js");
const { ensureDir } = require("./chatArchiveUtils");

const LOG = global.LOG || console;

// Use neuranet constants for reliable path resolution across execution contexts
const APPROOT = neuranetConstants.APPROOT;
const UPLOAD_DB_DIR = path.join(APPROOT, "Aiapp", "uploaded_files_db");

// Exported reasons for consistency
exports.REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION: "Execution failed"
};

/**
 * Store an uploaded file for a given chat.
 *
 * Supports two upload methods:
 *
 * 1. Base64 encoded (from frontend):
 *    jsonReq.chat_filename = "<same value you use for NDJSON>"
 *    jsonReq.file_data = "<base64 encoded file content>"
 *    jsonReq.filename = "something.pdf"
 *
 * 2. Multipart form-data (from other sources):
 *    jsonReq.chat_filename = "<same value you use for NDJSON>"
 *    _servObject.files[0] = {
 *      tmpFilePath: "/tmp/upload_xxx",
 *      originalFilename: "something.pdf",
 *      mimetype: "application/pdf",
 *      size: 1234
 *    }
 */
exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  if (!validateUploadRequest(jsonReq)) {
    LOG.error(`uploadChatFile: Validation failure. Incoming: ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: exports.REASONS.VALIDATION };
  }

  const { chat_filename, file_data, filename, id, org } = jsonReq;
  const nowISO = new Date().toISOString();

  try {
    LOG.info(`uploadChatFile: Upload request from user ${id} in org ${org}`);
    // Ensure root upload dir exists
    await ensureDir(UPLOAD_DB_DIR);

    // Resolve folder for this chat
    const chatFolderName = toSafeFolderName(chat_filename);    // no .ndjson
    const chatUploadDir  = path.join(UPLOAD_DB_DIR, chatFolderName);
    await ensureDir(chatUploadDir);

    let originalName, mimeType, size, fileContent;

    // ---- Handle base64 encoded file data ----
    if (file_data && filename) {
      LOG.info(`uploadChatFile: Processing base64 encoded file: ${filename}`);

      originalName = String(filename || "uploaded_file");
      // Try to detect MIME type from filename extension
      mimeType = _getMimeTypeFromFilename(originalName) || "application/octet-stream";

      // Decode base64 to buffer
      fileContent = Buffer.from(file_data, 'base64');
      size = fileContent.length;

      LOG.info(`uploadChatFile: File size: ${size} bytes`);
    }
    // ---- Handle multipart form-data file ----
    else {
      const fileObj = _servObject?.files?.[0];
      if (!fileObj || !fileObj.tmpFilePath) {
        LOG.error("uploadChatFile: No file data provided (neither base64 nor multipart)");
        return { result: false, reason: "No uploaded file found" };
      }

      originalName = String(fileObj.originalFilename || "uploaded_file");
      mimeType     = String(fileObj.mimetype || "application/octet-stream");
      size         = Number(fileObj.size || 0);
      const tmpFilePath  = fileObj.tmpFilePath;

      // Read file from temp location
      fileContent = await fsp.readFile(tmpFilePath);
      size = fileContent.length;

      // Delete temp file
      try {
        await fsp.unlink(tmpFilePath);
      } catch (e) {
        LOG.warn(`Could not delete temp file ${tmpFilePath}: ${e?.message || e}`);
      }
    }

    // Build a safe, mostly unique filename: <timestamp>__<sanitized_original>
    const safeOriginal   = toSafeFileName(originalName);
    const timeSuffix     = Date.now().toString();
    const storedFilename = `${timeSuffix}__${safeOriginal}`;
    const storedPath     = path.join(chatUploadDir, storedFilename);

    // Write file to permanent upload folder
    await fsp.writeFile(storedPath, fileContent, { mode: 0o600 });

    LOG.info(`uploadChatFile: stored file ${storedFilename} (${size} bytes) for chat=${chatFolderName}`);

    return {
      result: true,
      id,
      org,
      chat_filename,
      chat_folder: chatFolderName,
      stored_filename: storedFilename,
      stored_abs_path: storedPath,
      mime_type: mimeType,
      size,
      uploaded_on: nowISO
    };

  } catch (err) {
    LOG.error(`uploadChatFile: execution error: ${err?.stack || err}`);
    return { result: false, reason: exports.REASONS.EXECUTION };
  }
};

/**
 * Detect MIME type from file extension
 */
function _getMimeTypeFromFilename(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'json': 'application/json',
    'xml': 'application/xml',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip'
  };
  return mimeTypes[ext] || null;
}

// ------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------

function validateUploadRequest(req) {
  if (!req || typeof req !== "object") return false;
  const { chat_filename, id, org, file_data, filename } = req;
  if (!chat_filename || typeof chat_filename !== "string") return false;
  if (!id || typeof id !== "string") return false;
  if (!org || typeof org !== "string") return false;
  // Either file_data + filename (base64) or will be in _servObject.files (multipart)
  if (!file_data && !filename) {
    // Will check for _servObject.files later
  }
  return true;
}

/**
 * Sanitize folder name derived from chat filename.
 * We drop extensions and keep only [A-Za-z0-9._-].
 */
function toSafeFolderName(name) {
  let base = path.basename(String(name).trim());
  base = base.replace(/\.[^/.]+$/, "");       // remove trailing extension
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) base = "archive";
  return base;
}

/**
 * Sanitize stored file name.
 * Keeps extension but cleans base.
 */
function toSafeFileName(fileName) {
  let base = path.basename(String(fileName).trim());
  const ext = path.extname(base);
  let nameNoExt = base.slice(0, base.length - ext.length);
  nameNoExt = nameNoExt.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!nameNoExt) nameNoExt = "file";
  return `${nameNoExt}${ext}`;
}
