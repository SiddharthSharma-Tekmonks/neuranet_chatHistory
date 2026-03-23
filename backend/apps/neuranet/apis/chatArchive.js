/**
 * @module chatArchive (API entry point)
 *
 * Single API endpoint for all chat archive operations.
 * Dispatches to the appropriate handler in lib/chatArchive.js based on `service`.
 *
 * Supported service values:
 *   "readAll"          — load full chat session (messages + descriptor)
 *   "listTimestamps"   — list saved chats with metadata for sidebar
 *   "appendMessage"    — append a user/assistant message; uploads attached_files if present
 *   "updateTitle"      — rename a chat session
 *   "deleteChat"       — delete chat file and metadata record
 */

const chatArchive = require("../lib/chatArchive");

const HANDLERS = {
  readAll:        req     => chatArchive.readAll(req),
  listTimestamps: req     => chatArchive.listTimestamps(req),
  appendMessage:  req     => chatArchive.appendMessage(req),
  updateTitle:    req     => chatArchive.updateTitle(req),
  deleteChat:     req     => chatArchive.deleteChat(req),
};

exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  const handler = HANDLERS[String(jsonReq?.service || "")];
  if (!handler) {
    LOG.error(`chatArchive API: unknown service "${jsonReq?.service}"`);
    return { result: false, reason: "Unknown service" };
  }
  return handler(jsonReq);
};
