/**
 * @module chatArchive
 * @description Library for all chat archive operations.
 *
 * Exported handlers (called by apis/chatArchive.js):
 *   loadChat(jsonReq)           — load full chat session from NDJSON file
 *   listChatsMetadata(jsonReq)    — list saved chats with metadata for sidebar
 *   appendMessage(jsonReq)     — append a user/assistant message; if jsonReq.attached_files
 *                                is present, uploads each file first then stores refs in the message
 *   updateTitle(jsonReq)       — rename a chat session
 *   deleteChat(jsonReq)        — delete chat file + metadata record
 */

const readline = require("readline");
const fs   = require("fs");
const fsp  = require("fs/promises");
const path = require("path");
const neuranetConstants = require("./neuranetconstants.js");

// ─── Paths ───────────────────────────────────────────────────────────────────

const APPROOT       = neuranetConstants.APPROOT;
const ARCHIVE_ROOT  = path.join(APPROOT, "db", "chatarchive_db");
const CHAT_DB_DIR   = path.join(ARCHIVE_ROOT, "chats");
const META_DB_FILE  = path.join(ARCHIVE_ROOT, "chat_meta.json");
const UPLOAD_DB_DIR = path.join(ARCHIVE_ROOT, "uploaded_files");

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
  if (!jsonReq?.chat_filename || typeof jsonReq.chat_filename !== "string") {
    LOG.error(`chatArchive/loadChat: validation failed for ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: REASONS.VALIDATION };
  }

  try {
    const safeName     = _toSafeNdjsonName(jsonReq.chat_filename);
    const chatFilePath = path.join(CHAT_DB_DIR, safeName);

    if (!fs.existsSync(chatFilePath) || !fs.statSync(chatFilePath).isFile()) {
      return { result: false, reason: REASONS.NOT_FOUND };
    }

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
  const aiApp = String(
    jsonReq?.ai_app ?? jsonReq?.app ?? jsonReq?.view ?? jsonReq?.viewid ?? ""
  ).trim();

  if (!aiApp) {
    LOG.error("chatArchive/listChatsMetadata: ai_app is required");
    return { result: false, reason: REASONS.VALIDATION };
  }
  if (jsonReq.prefix          != null && typeof jsonReq.prefix          !== "string")  return { result: false, reason: REASONS.VALIDATION };
  if (jsonReq.pattern         != null && typeof jsonReq.pattern         !== "string")  return { result: false, reason: REASONS.VALIDATION };
  if (jsonReq.caseInsensitive != null && typeof jsonReq.caseInsensitive !== "boolean") return { result: false, reason: REASONS.VALIDATION };

  try {
    const metadataDB    = await _loadMetaDB(META_DB_FILE);
    const existingFiles = new Set(await _safeListNdjson(CHAT_DB_DIR));
    const rawPrefix     = (jsonReq.prefix ?? jsonReq.pattern ?? "").toString();
    const ci            = !!jsonReq.caseInsensitive;
    const prefix        = ci ? rawPrefix.toLowerCase() : rawPrefix;

    const files = Object.keys(metadataDB)
      .filter(name => {
        if (!existingFiles.has(name)) return false;
        if ((metadataDB[name]?.ai_app || "") !== aiApp) return false;
        if (!prefix) return true;
        return (ci ? name.toLowerCase() : name).startsWith(prefix);
      })
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

  } catch (err) {
    LOG.error(`chatArchive/listChatsMetadata: ${err?.stack || err}`);
    return { result: false, reason: REASONS.EXECUTION };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: appendMessage
//
// Appends a user or assistant message to an NDJSON chat file and updates metadata.
//
// If jsonReq.attached_files is a non-empty array, each file is uploaded to the
// chat's upload folder first and the resulting stored refs are embedded in the
// message's `files` field before the append.
//
// jsonReq.attached_files shape:
//   [{ filename: string, fileid: string, file_data: string (base64) }, ...]
// ═══════════════════════════════════════════════════════════════════════════════

async function appendMessage(jsonReq) {
  const { role, message, chat_filename, ai_app, chatsession_id,
          thoughts, thoughts_mime, attached_files } = jsonReq || {};

  if (!chat_filename || typeof chat_filename !== "string" || message == null ||
      !role || (role !== "user" && role !== "assistant")) {
    LOG.error(`chatArchive/appendMessage: validation failed for ${JSON.stringify(jsonReq)}`);
    return { result: false, reason: REASONS.VALIDATION };
  }

  const nowISO = new Date().toISOString();

  try {
    await _ensureDir(CHAT_DB_DIR);
    await _ensureDir(ARCHIVE_ROOT);

    const safeName  = _toSafeNdjsonName(chat_filename);
    const filePath  = path.join(CHAT_DB_DIR, safeName);
    const isNewFile = !fs.existsSync(filePath);
    if (isNewFile) await fsp.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });

    // Upload attached files (if any) and collect stored refs
    const has_files = Array.isArray(attached_files) && attached_files.length > 0;
    const files = has_files
      ? (await Promise.all(attached_files.map(f => _uploadSingleFile(chat_filename, f)))).filter(Boolean)
      : [];

    const msgObj = { type: "message", role: String(role), message, ts: nowISO };
    if (files.length > 0) msgObj.files = files;
    if (thoughts && role === "assistant") {
      msgObj.thoughts      = String(thoughts);
      msgObj.thoughts_mime = thoughts_mime || "text/markdown";
    }

    let messageAppended = false;
    try {
      await fsp.appendFile(filePath, JSON.stringify(msgObj) + "\n", { encoding: "utf8", mode: 0o600 });
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

      LOG.info(`chatArchive/appendMessage: wrote to ${filePath}; meta updated (newFile=${isNewFile}, hasFiles=${has_files})`);
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
  const safeName = _toSafeNdjsonName(jsonReq?.chat_filename);
  const aiAppId  = String(jsonReq?.ai_app  || "").trim();
  const newTitle = String(jsonReq?.title   || "").trim();

  if (!safeName || !aiAppId || !newTitle) return { result: false, reason: REASONS.VALIDATION };

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
  const safeName = _toSafeNdjsonName(jsonReq?.chat_filename);
  const aiAppId  = String(jsonReq?.ai_app || "").trim();

  if (!safeName || !aiAppId) return { result: false, reason: REASONS.VALIDATION };

  try {
    const metadataDB = await _loadMetaDB(META_DB_FILE);
    const entry      = metadataDB[safeName];

    if (!entry)                           return { result: false, reason: REASONS.NOT_FOUND };
    if ((entry.ai_app || "") !== aiAppId) return { result: false, reason: REASONS.FORBIDDEN };

    const chatFilePath = path.join(path.resolve(CHAT_DB_DIR), safeName);
    try {
      if (fs.existsSync(chatFilePath) && fs.statSync(chatFilePath).isFile()) await fsp.unlink(chatFilePath);
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

/**
 * Upload a single file to the chat's upload folder.
 * Used internally by appendMessage when attached_files are present.
 * Returns a stored-ref object on success, or a partial ref on failure.
 */
async function _uploadSingleFile(chat_filename, fileObj) {
  try {
    const { filename, fileid, file_data } = fileObj || {};
    if (!file_data || !filename) return { filename, fileid };

    const chatFolderName = _toSafeFolderName(chat_filename);
    const chatUploadDir  = path.join(UPLOAD_DB_DIR, chatFolderName);
    await _ensureDir(UPLOAD_DB_DIR);
    await _ensureDir(chatUploadDir);

    const originalName   = String(filename || "uploaded_file");
    const mimeType       = _mimeFromFilename(originalName) || "application/octet-stream";
    const fileContent    = Buffer.from(file_data, "base64");
    const storedFilename = `${Date.now()}__${_toSafeFileName(originalName)}`;
    const storedPath     = path.join(chatUploadDir, storedFilename);

    await fsp.writeFile(storedPath, fileContent, { mode: 0o600 });
    LOG.debug(`chatArchive/_uploadSingleFile: stored ${storedFilename} for chat=${chatFolderName}`);

    return { filename, fileid, stored_filename: storedFilename, stored_abs_path: storedPath, mime_type: mimeType, size: fileContent.length };
  } catch (err) {
    LOG.error(`chatArchive/_uploadSingleFile: failed for ${fileObj?.filename}: ${err?.message}`);
    return { filename: fileObj?.filename, fileid: fileObj?.fileid };
  }
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
    const data = await fsp.readFile(filePath, "utf8");
    const obj  = JSON.parse(data);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}

async function _saveMetaDBAtomic(filePath, obj) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

async function _ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

async function _safeListNdjson(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith(".ndjson") && !e.name.startsWith(".")).map(e => e.name);
  } catch { return []; }
}

async function _readNdjsonAsArray(filePath) {
  const handle = await fsp.open(filePath, "r");
  const msgs   = [];
  try {
    const rl = readline.createInterface({ input: handle.createReadStream({ encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const t = (line || "").trim();
      if (!t) continue;
      try { msgs.push(JSON.parse(t)); } catch { /* skip malformed lines */ }
    }
    return msgs;
  } finally { await handle.close(); }
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
  const content = await fsp.readFile(filePath, "utf8");
  const lines   = content.split("\n");
  if (lines.length > 1) lines.pop();
  if (lines.length > 0) lines.pop();
  await fsp.writeFile(filePath, lines.length > 0 ? lines.join("\n") + "\n" : "", { encoding: "utf8", mode: 0o600 });
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
