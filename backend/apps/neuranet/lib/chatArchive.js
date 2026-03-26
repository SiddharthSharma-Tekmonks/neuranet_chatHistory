/**
 * @module chatArchive
 * @description Library for all chat archive operations.
 *
 * Exported handlers (called by apis/chatArchive.js):
 *   loadChat(jsonReq)          — load full chat session from NDJSON file
 *   listChatsMetadata(jsonReq) — list saved chats with metadata for sidebar
 *   appendMessage(jsonReq)     — append a user/assistant message; if jsonReq.attached_files
 *                                is present, uploads each file first then stores refs in the message
 *   updateTitle(jsonReq)       — rename a chat session
 *   deleteChat(jsonReq)        — delete chat file + metadata record
 */

const fspromises = require("fs").promises;
const path       = require("path");

// ─── Paths (from neuranet constants) ─────────────────────────────────────────

const CHAT_DB_DIR   = NEURANET_CONSTANTS.CHATARCHIVE_CHATS_DIR;
const META_DB_FILE  = NEURANET_CONSTANTS.CHATARCHIVE_META_FILE;
const UPLOAD_DB_DIR = NEURANET_CONSTANTS.CHATARCHIVE_UPLOADS_DIR;

// ─── Shared error reasons ─────────────────────────────────────────────────────

const REASONS = {
  VALIDATION: "Validation failed",
  EXECUTION:  "Execution failed",
  NOT_FOUND:  "File not found",
  FORBIDDEN:  "ai_app mismatch",
};

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: loadChat
// Load a complete chat session (descriptor + messages) from an NDJSON file.
// ═══════════════════════════════════════════════════════════════════════════════

async function loadChat(jsonReq) {
  try {
    const safeName     = _toSafeNdjsonName(jsonReq.chat_filename);
    const chatFilePath = path.join(CHAT_DB_DIR, safeName);

    if (!await _isFile(chatFilePath)) return { result: false, reason: REASONS.NOT_FOUND };

    const messages   = await _readNdjsonAsArray(chatFilePath);
    const metadataDB = await _loadMetaDB(META_DB_FILE);
    const meta       = metadataDB[safeName] || {};

    const descriptor = {
      type:            "descriptor",
      created_on:      meta.created_on      || null,
      last_updated_on: meta.last_updated_on || null,
      chat_filename:   safeName,
      ai_app:          meta.ai_app          || null,
      chatsession_id:  meta.chatsession_id  ?? null,
      title:           meta.title           || null,
    };

    const combined = [descriptor, ...messages];
    return { result: true, filepath: chatFilePath, objects: combined, count: combined.length };

  } catch (err) {
    LOG.error(`chatArchive/loadChat: ${err?.stack || err}`);
    return { result: false, reason: REASONS.EXECUTION };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: listChatsMetadata
// Return sorted list of chat archives for a given ai_app (for sidebar).
// ═══════════════════════════════════════════════════════════════════════════════

async function listChatsMetadata(jsonReq) {
  try {
    const aiApp         = String(jsonReq.ai_app ?? jsonReq.app ?? jsonReq.view ?? jsonReq.viewid ?? "").trim();
    const metadataDB    = await _loadMetaDB(META_DB_FILE);
    const existingFiles = new Set(await _safeListNdjson(CHAT_DB_DIR));
    const rawPrefix     = (jsonReq.prefix ?? jsonReq.pattern ?? "").toString();
    const caseInsensitive = !!jsonReq.caseInsensitive;
    const prefix        = caseInsensitive ? rawPrefix.toLowerCase() : rawPrefix;

    const files = Object.keys(metadataDB)
      .filter(chatName => {
        if (!existingFiles.has(chatName)) return false;
        if ((metadataDB[chatName]?.ai_app || "") !== aiApp) return false;
        if (!prefix) return true;
        return (caseInsensitive ? chatName.toLowerCase() : chatName).startsWith(prefix);
      })
      .map(chatName => {
        const meta = metadataDB[chatName] || {};
        const ts   = meta.last_updated_on || meta.created_on || null;
        return { chat_filename: chatName, title: meta.title || null, chatsession_id: meta.chatsession_id ?? null, ts, source: ts ? "meta" : null };
      })
      .sort((chatA, chatB) => {
        if (!chatA.ts && !chatB.ts) return 0;
        if (!chatA.ts) return 1;
        if (!chatB.ts) return -1;
        return chatA.ts < chatB.ts ? 1 : (chatA.ts > chatB.ts ? -1 : 0);
      });

    return { result: true, dir: path.resolve(CHAT_DB_DIR), files, count: files.length };

  } catch (err) {
    LOG.error(`chatArchive/listChatsMetadata: ${err?.stack || err}`);
    return { result: false, reason: REASONS.EXECUTION };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: appendMessage
//
// Appends a user or assistant message to an NDJSON chat file and updates metadata.
// If jsonReq.attached_files is present, each file is uploaded first and the
// stored refs are embedded in the message's `files` field.
//
// jsonReq.attached_files shape:
//   [{ filename: string, fileid: string, file_data: string (base64) }, ...]
// ═══════════════════════════════════════════════════════════════════════════════

async function appendMessage(jsonReq) {
  const { role, message, chat_filename, ai_app, chatsession_id,
          thoughts, thoughts_mime, attached_files } = jsonReq;
  const nowISO = new Date().toISOString();

  try {
    const safeName  = _toSafeNdjsonName(chat_filename);
    const filePath  = path.join(CHAT_DB_DIR, safeName);
    const isNewFile = !await _isFile(filePath);
    if (isNewFile) await fspromises.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });

    const hasFiles = Array.isArray(attached_files) && attached_files.length > 0;
    const files = hasFiles
      ? (await Promise.all(attached_files.map(fileItem => _uploadSingleFile(chat_filename, fileItem)))).filter(Boolean)
      : [];

    const msgObj = { type: "message", role: String(role), message, ts: nowISO };
    if (files.length > 0) msgObj.files = files;
    if (thoughts && role === "assistant") {
      msgObj.thoughts      = String(thoughts);
      msgObj.thoughts_mime = thoughts_mime || "text/markdown";
    }

    let messageAppended = false;
    try {
      await fspromises.appendFile(filePath, JSON.stringify(msgObj) + "\n", { encoding: "utf8", mode: 0o600 });
      messageAppended = true;
      LOG.debug(`chatArchive/appendMessage: appended to ${filePath}`);
    } catch (appendErr) {
      LOG.error(`chatArchive/appendMessage: append failed: ${appendErr?.message}`);
      throw appendErr;
    }

    try {
      const metaDB       = await _loadMetaDB(META_DB_FILE);
      const existingMeta = metaDB[safeName] || null;

      const metaRecord = existingMeta ? { ...existingMeta } : {
        chat_filename:  safeName,
        created_on:     nowISO,
        title:          _buildTitle(message),
        ai_app:         ai_app || null,
        chatsession_id: chatsession_id ?? null,
      };

      metaRecord.last_updated_on = nowISO;
      if (!metaRecord.ai_app && ai_app) metaRecord.ai_app = ai_app;
      if (metaRecord.chatsession_id == null && chatsession_id != null) metaRecord.chatsession_id = chatsession_id;
      if ((!metaRecord.title || !String(metaRecord.title).trim()) && message) metaRecord.title = _buildTitle(message);

      metaDB[safeName] = metaRecord;
      await _saveMetaDBAtomic(META_DB_FILE, metaDB);

      LOG.info(`chatArchive/appendMessage: wrote to ${filePath}; meta updated (newFile=${isNewFile}, hasFiles=${hasFiles})`);
      return { result: true, filepath: filePath, descriptorAdded: false, metaUpdated: true };

    } catch (metaErr) {
      if (messageAppended) {
        try {
          LOG.warn(`chatArchive/appendMessage: meta update failed, rolling back: ${metaErr?.message}`);
          await _removeLastLine(filePath);
        } catch (rbErr) {
          LOG.error(`chatArchive/appendMessage: CRITICAL rollback failed: ${rbErr?.message}`);
        }
      }
      throw metaErr;
    }

  } catch (err) {
    LOG.error(`chatArchive/appendMessage: ${err?.stack || err}`);
    return { result: false, reason: REASONS.EXECUTION };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: updateTitle
// Rename a chat session's display title.
// ═══════════════════════════════════════════════════════════════════════════════

async function updateTitle(jsonReq) {
  const safeName = _toSafeNdjsonName(jsonReq.chat_filename);
  const aiAppId  = String(jsonReq.ai_app || "").trim();
  const newTitle = String(jsonReq.title  || "").trim();

  try {
    const metadataDB = await _loadMetaDB(META_DB_FILE);
    const entry      = metadataDB[safeName];

    if (!entry)                           return { result: false, reason: REASONS.NOT_FOUND };
    if ((entry.ai_app || "") !== aiAppId) return { result: false, reason: REASONS.FORBIDDEN };

    entry.title           = newTitle;
    entry.last_updated_on = new Date().toISOString();
    metadataDB[safeName]  = entry;
    await _saveMetaDBAtomic(META_DB_FILE, metadataDB);

    return { result: true, action: "updateTitle", chat_filename: safeName, ai_app: aiAppId, title: entry.title, last_updated_on: entry.last_updated_on };

  } catch (err) {
    LOG.error(`chatArchive/updateTitle: ${err?.stack || err}`);
    return { result: false, reason: REASONS.EXECUTION };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: deleteChat
// Remove the NDJSON message file and its metadata entry.
// ═══════════════════════════════════════════════════════════════════════════════

async function deleteChat(jsonReq) {
  const safeName = _toSafeNdjsonName(jsonReq.chat_filename);
  const aiAppId  = String(jsonReq.ai_app || "").trim();

  try {
    const metadataDB = await _loadMetaDB(META_DB_FILE);
    const entry      = metadataDB[safeName];

    if (!entry)                           return { result: false, reason: REASONS.NOT_FOUND };
    if ((entry.ai_app || "") !== aiAppId) return { result: false, reason: REASONS.FORBIDDEN };

    const chatFilePath = path.join(CHAT_DB_DIR, safeName);
    try {
      if (await _isFile(chatFilePath)) await fspromises.unlink(chatFilePath);
    } catch (unlinkErr) {
      LOG.warn(`chatArchive/deleteChat: unlink failed for ${chatFilePath}: ${unlinkErr?.message}`);
    }

    delete metadataDB[safeName];
    await _saveMetaDBAtomic(META_DB_FILE, metadataDB);

    return { result: true, action: "deleteChat", chat_filename: safeName, ai_app: aiAppId, removed_file: true, removed_meta: true };

  } catch (err) {
    LOG.error(`chatArchive/deleteChat: ${err?.stack || err}`);
    return { result: false, reason: REASONS.EXECUTION };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Private utilities
// ═══════════════════════════════════════════════════════════════════════════════

async function _uploadSingleFile(chat_filename, fileItem) {
  try {
    const { filename, fileid, file_data } = fileItem || {};
    if (!file_data || !filename) {
      LOG.warn(`chatArchive/_uploadSingleFile: skipping "${filename}" — missing filename or file_data`);
      return { filename, fileid };
    }

    const fileContent = Buffer.from(file_data, "base64");
    if (fileContent.length === 0) {
      LOG.warn(`chatArchive/_uploadSingleFile: skipping "${filename}" — decoded content is empty`);
      return { filename, fileid };
    }

    const chatUploadDir  = path.join(UPLOAD_DB_DIR, _toSafeFolderName(chat_filename));
    await fspromises.mkdir(chatUploadDir, { recursive: true, mode: 0o700 });

    const originalName   = String(filename || "uploaded_file");
    const mimeType       = _mimeFromFilename(originalName) || "application/octet-stream";
    const storedFilename = `${Date.now()}__${_toSafeFileName(originalName)}`;
    const storedPath     = path.join(chatUploadDir, storedFilename);

    await fspromises.writeFile(storedPath, fileContent, { mode: 0o600 });
    LOG.debug(`chatArchive/_uploadSingleFile: stored ${storedFilename} (${fileContent.length} bytes)`);

    return { filename, fileid, stored_filename: storedFilename, stored_abs_path: storedPath, mime_type: mimeType, size: fileContent.length };
  } catch (err) {
    LOG.error(`chatArchive/_uploadSingleFile: failed for "${fileItem?.filename}": ${err?.message}`);
    return { filename: fileItem?.filename, fileid: fileItem?.fileid };
  }
}

async function _isFile(filePath) {
  try { return (await fspromises.stat(filePath)).isFile(); } catch { return false; }
}

function _toSafeNdjsonName(rawName) {
  let base = path.basename(String(rawName || "").trim());
  base = base.replace(/\.[^/.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) return "";
  return `${base}.ndjson`;
}

function _toSafeFolderName(name) {
  let base = path.basename(String(name).trim());
  base = base.replace(/\.[^/.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "archive";
}

function _toSafeFileName(fileName) {
  const base = path.basename(String(fileName).trim());
  const ext  = path.extname(base);
  const stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${stem || "file"}${ext}`;
}

async function _loadMetaDB(filePath) {
  try {
    const data = await fspromises.readFile(filePath, "utf8");
    const obj  = JSON.parse(data);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}

async function _saveMetaDBAtomic(filePath, obj) {
  await fspromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = filePath + ".tmp";
  await fspromises.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  await fspromises.rename(tmp, filePath);
}

async function _safeListNdjson(dir) {
  try {
    const entries = await fspromises.readdir(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith(".ndjson") && !entry.name.startsWith("."))
      .map(entry => entry.name);
  } catch { return []; }
}

async function _readNdjsonAsArray(filePath) {
  try {
    const content = await fspromises.readFile(filePath, "utf8");
    return content.split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

function _buildTitle(message, maxLen = 40) {
  if (!message) return "Chat";
  const cleaned = String(message).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length <= maxLen) return cleaned || "Chat";
  const chunk     = cleaned.slice(0, maxLen);
  const lastSpace = chunk.lastIndexOf(" ");
  return lastSpace > 0 ? chunk.slice(0, lastSpace).trim() + "..." : chunk.slice(0, 15).trim() + "...";
}

async function _removeLastLine(filePath) {
  const content = await fspromises.readFile(filePath, "utf8");
  const lines   = content.split("\n");
  if (lines.length > 1) lines.pop();
  if (lines.length > 0) lines.pop();
  await fspromises.writeFile(filePath, lines.length > 0 ? lines.join("\n") + "\n" : "", { encoding: "utf8", mode: 0o600 });
}

function _mimeFromFilename(filename) {
  const ext = filename.toLowerCase().split(".").pop();
  return ({
    pdf:"application/pdf", doc:"application/msword",
    docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls:"application/vnd.ms-excel",
    xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt:"application/vnd.ms-powerpoint",
    pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt:"text/plain", csv:"text/csv", json:"application/json", xml:"application/xml",
    jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", gif:"image/gif",
    zip:"application/zip", tar:"application/x-tar", gz:"application/gzip",
  })[ext] || null;
}

module.exports = { loadChat, listChatsMetadata, appendMessage, updateTitle, deleteChat };
