/** 
 * Neuranet constants.
 * (C) 2022 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const path = require("path");
const BACKEND_ROOT = path.resolve(`${__dirname}/../`);
const APPROOT = BACKEND_ROOT;

exports.APPROOT = path.resolve(APPROOT);
exports.APIDIR = path.resolve(`${APPROOT}/apis`);
exports.CONFDIR = path.resolve(`${APPROOT}/conf`);
exports.LIBDIR = path.resolve(`${APPROOT}/lib`);
exports.HTTPDCONFDIR = path.resolve(`${BACKEND_ROOT}/conf`);
exports.TRAININGPROMPTSDIR = path.resolve(`${APPROOT}/training_prompts`);
exports.RESPONSESDIR = path.resolve(`${APPROOT}/sample_responses`);
exports.TEMPDIR = path.resolve(`${APPROOT}/temp`);
exports.THIRDPARTYDIR = path.resolve(`${APPROOT}/3p`);
exports.PLUGINSDIR = path.resolve(`${APPROOT}/plugins`);
exports.DBDIR = path.resolve(`${BACKEND_ROOT}/db/sqlite`);
exports.AIDBPATH = path.resolve(`${exports.DBDIR}/../ai_db`);
exports.DEFAULT_ORG = "_org_neuranet_defaultorg_";
exports.DEFAULT_ID = "_default_";
exports.AIAPPDIR = path.resolve(`${BACKEND_ROOT}/aiapps`);
exports.AIAPPMODES = {EDIT: 'editaiapp', TRAIN: 'trainaiapp'};
exports.DEFAULT_ORG_DEFAULT_AIAPP = "_org_neuranet_default_aiapp_";
exports.DEFAULT_AIAPP_LABEL = "AI assistant";

exports.REFERENCELINK_METADATA_KEY = "referencelink";

exports.NEURANET_DOCID = "aidb_docid";
exports.NEURANET_LANGID = "aidb_langid";

exports.GENERATED_FILES_FOLDER = "_neuranet_generated";

exports.CLUSTERCOUNT_KEY = "_neuranet_cluster_count";

exports.ROLES = {ADMIN: "admin", USER: "user"};

exports.getPlugin = name => require(`${exports.LIBDIR}/pluginhandler.js`).getPlugin(name);

exports.CHATARCHIVE_ROOT       = path.resolve(`${BACKEND_ROOT}/db/chatarchive_db`);
exports.CHATARCHIVE_CHATS_DIR  = path.resolve(`${exports.CHATARCHIVE_ROOT}/chats`);
exports.CHATARCHIVE_META_FILE  = path.resolve(`${exports.CHATARCHIVE_ROOT}/chat_meta.json`);
exports.CHATARCHIVE_UPLOADS_DIR = path.resolve(`${exports.CHATARCHIVE_ROOT}/uploaded_files`);

exports.NEURANETEVENT = "__org_monkshu_neuranet_event";
exports.EVENTS = Object.freeze({AIDB_FILE_PROCESSING: "aidb_file_processing", AIDB_FILE_PROGRESS: "aidb_file_progress", 
    AIDB_FILE_PROCESSED: "aidb_file_processed", FILE_CREATED: "filecreated",
    FILE_DELETED: "filedeleted", FILE_RENAMED: "filerenamed", FILE_MODIFIED: "filemodified"});
exports.FILEINDEXER_FILE_PROCESSED_EVENT_TYPES = Object.freeze({INGESTED: "ingest_process",
    UNINGESTED: "uningest_process", RENAMED: "rename_process", MODIFIED: "modified_process"});