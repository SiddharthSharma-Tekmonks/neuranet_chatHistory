/**
 * @module chatArchive (API entry point)
 *
 * Single API endpoint for all chat archive operations.
 * Dispatches to the appropriate handler in lib/chatArchive.js based on `service`.
 *
 * API Request (all services require):
 *   id      - The user ID
 *   org     - The user org
 *   service - Operation to perform (see below)
 *
 * Supported service values and their additional required fields:
 *   "loadChat"          — chat_filename
 *   "listChatsMetadata" — ai_app
 *   "appendMessage"     — chat_filename, role, message
 *   "updateTitle"       — chat_filename, ai_app, title
 *   "deleteChat"        — chat_filename, ai_app
 */

const chatArchive = require("../lib/chatArchive");

const HANDLERS = {
  loadChat:          req => chatArchive.loadChat(req),
  listChatsMetadata: req => chatArchive.listChatsMetadata(req),
  appendMessage:     req => chatArchive.appendMessage(req),
  updateTitle:       req => chatArchive.updateTitle(req),
  deleteChat:        req => chatArchive.deleteChat(req),
};

const VALIDATORS = {
  loadChat:          req => req.chat_filename && typeof req.chat_filename === "string",
  listChatsMetadata: req => Boolean(req.ai_app),
  appendMessage:     req => typeof req.chat_filename === "string" && req.message != null &&
                            (req.role === "user" || req.role === "assistant"),
  updateTitle:       req => typeof req.chat_filename === "string" && req.ai_app &&
                            req.title && String(req.title).trim().length > 0,
  deleteChat:        req => typeof req.chat_filename === "string" && req.ai_app,
};

const validateRequest = jsonReq => (jsonReq && jsonReq.id && jsonReq.org && jsonReq.service && HANDLERS[jsonReq.service]);

exports.doService = async (jsonReq, _servObject, _headers, _url) => {
  if (!validateRequest(jsonReq)) {
    LOG.error(`chatArchive API: validation failed for service="${jsonReq?.service}" id="${jsonReq?.id}" org="${jsonReq?.org}"`);
    return { result: false, reason: "Validation failed" };
  }

  const serviceName = String(jsonReq.service).trim();

  if (!VALIDATORS[serviceName](jsonReq)) {
    LOG.error(`chatArchive API: service validation failed for service="${serviceName}" id="${jsonReq.id}"`);
    return { result: false, reason: "Validation failed" };
  }

  LOG.debug(`chatArchive API: dispatching service="${serviceName}" for id="${jsonReq.id}"`);

  try {
    return await HANDLERS[serviceName](jsonReq);
  } catch (error) {
    LOG.error(`chatArchive API: unhandled error in service="${serviceName}": ${error?.stack || error}`);
    return { result: false, reason: "Internal server error" };
  }
};
