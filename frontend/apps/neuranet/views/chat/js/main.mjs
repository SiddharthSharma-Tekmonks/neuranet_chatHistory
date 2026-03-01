/** 
 * View main module for the chat view.
 * 
 * (C) 2023 Tekmonks Corp.
 */

import {i18n} from "/framework/js/i18n.mjs";
import {util} from "/framework/js/util.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";

const API_SSE_EVENTS = "sseevents", NN_THOUGHTS_EVENT_NAME = "thoughts", LLMFLOW_STATUS_WAITING = "waiting", POLL_WAIT = 3000;

let chatsessionID, old_thoughts={}, thoughtSubscribers=[], VIEW_PATH, AI_ENDPOINT, mustache;
chatsessionID = session.get(APP_CONSTANTS.CHAT_SESSION_ID,chatsessionID);

async function initView(data) {
    mustache = await router.getMustache();
    window.monkshu_env.apps[APP_CONSTANTS.APP_NAME] = {
        ...(window.monkshu_env.apps[APP_CONSTANTS.APP_NAME]||{}), chat_main: main}; 
    data.VIEW_PATH = data.viewpath;
    VIEW_PATH = data.viewpath;
    AI_ENDPOINT = data.aiendpoint;
    i18n.addPath(`${VIEW_PATH}`);
    
    const starterPrompts = (await i18n.get("ChatStarterPrompts")).split("|").map(value=>value.trim());
    const randomPrompt = starterPrompts[Math.floor(Math.random()*starterPrompts.length)];
    const userfname = session.get(APP_CONSTANTS.USERNAME).toString().split(" ")[0];
    data.greeting = mustache.render(randomPrompt, {name: userfname});  // random greeting

    data.tts_flag = data.activeaiapp.interface.tts == true ? "true" : "false";
    data.stt_flag = data.activeaiapp.interface.stt == true ? "true" : "false";
    data.typewriter = data.activeaiapp.interface.typewriter == false ? undefined : 2;

    _setupSSEEvents();
    session.set(APP_CONSTANTS.FORCE_LOAD_VIEW, data.activeaiapp.id);
}

async function getAssistantResult(question, files, message_id, chatbox, aiappid, poll) {
    // Upload files if provided
    let uploadedFileReferences = [];
    if (files && files.length > 0) {
        uploadedFileReferences = await _uploadFiles(files, message_id);
    }

    const request = {id: session.get(APP_CONSTANTS.USERID).toString(), org: session.get(APP_CONSTANTS.USERORG).toString(),
        question, session_id: chatsessionID, aiappid, files: uploadedFileReferences, message_id, jobrequest: poll};
    thoughtSubscribers[message_id] = async thoughts =>  // update chat with thoughts of the model while producing the final response
        chatbox.insertAIThoughts(thoughts.join("\n\n"), "text/markdown", message_id);

    let result = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${AI_ENDPOINT}`, "POST", request, true); delete request.jobrequest;
    let resultPromise = new Promise(resolve => {
        if (result?.status == LLMFLOW_STATUS_WAITING) {
            const waitInterval = setInterval(async _ => {
                result = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${AI_ENDPOINT}`, "POST", {...request, jobresponse: true}, true);
                if (result.status != LLMFLOW_STATUS_WAITING) {clearInterval(waitInterval); resolve();}
            }, POLL_WAIT);
        } else resolve();
    });
    await resultPromise;  // this ensures we have waited for polled responses

    if (result.session_id){
        chatsessionID = result.session_id;  // save session ID so that backend can maintain session
        session.set(APP_CONSTANTS.CHAT_SESSION_ID,chatsessionID);
    }  

    // handle all errors here and return early
    const doErrorResult = async err => chatbox.insertAIResponse({error: err||(await i18n.get("ChatAIError")), ok: false, mime: "text/markdown"});
    if (!result?.result) {
        doErrorResult(result?.reason == "limit"?await i18n.get("ErrorConvertingAIQuotaLimit"):undefined); 
        return;
    }

    // coming here means we have a good response with no errors
    const resultRendered = await parseAIResponse(result, chatbox);
    chatbox.insertAIResponse({ok: true, response: resultRendered, mime: "text/markdown"}, message_id);
    setTimeout(_=>delete thoughtSubscribers[message_id], 2000);  // response is final, thoughts can't be updated anymore
}

async function parseAIResponse(ai_result, chatbox) {
    if (!ai_result.jsonResponse) ai_result.jsonResponse = {response: ai_result.response};  // handle simple results here

    const rendered = ai_result.jsonResponse.response;
    if (ai_result.jsonResponse.analysis_code) {      // add collapsible section for internal code etc
        const collapsibleSection = chatbox.getCollapsibleSection(await i18n.get("ChatAnalysisLabel"), 
            `\`\`\`${ai_result.jsonResponse.code_language.toLowerCase()}\n${ai_result.jsonResponse.analysis_code}\n\`\`\`\n`);
        rendered = collapsibleSection + rendered;  
    }

    return rendered;
}

function _setupSSEEvents() {
    const id = session.get(APP_CONSTANTS.USERID).toString(), org = session.get(APP_CONSTANTS.USERORG).toString();
    const sseURL = `${APP_CONSTANTS.API_PATH}/${API_SSE_EVENTS}`;
    const sse = apiman.subscribeSSEEvents(sseURL, {id, org}, true);
    sse.addEventListener(NN_THOUGHTS_EVENT_NAME, event => { // API thought events
        try {
            const thought_events = JSON.parse(event.data).events;
            if (!util.areObjectsEqual(old_thoughts, thought_events)) {
                _newThoughtsDetected(old_thoughts, thought_events);
                old_thoughts = thought_events;
            }
        } catch (err) {LOG.error(`Error parsing thought events, skipping this SSE update.`);}
    });
}

function _newThoughtsDetected(oldThoughts, newThoughts) {
    for (const [message_id, thoughts] of Object.entries(newThoughts))
        if (oldThoughts[message_id]?.sort().join(",") != thoughts.sort().join(",")) // this checks members are equal in the two arrays
            if (thoughtSubscribers[message_id]) thoughtSubscribers[message_id](thoughts);
}

/**
 * Upload files to the backend for storage
 * @param {Array} files - Array of file objects with {filename, bytes64, fileid}
 * @param {string} message_id - The message ID to associate with files
 * @returns {Promise<Array>} Array of uploaded file references
 */
async function _uploadFiles(files, message_id) {
    const uploadedFiles = [];
    const uploadAPI = `${APP_CONSTANTS.API_PATH}/uploadChatFile`;
    const chatFilename = session.get(APP_CONSTANTS.CHAT_FILENAME) || `chat_${message_id}`;

    LOG.info(`Starting file upload for ${files.length} files to ${uploadAPI}`);

    for (const fileObj of files) {
        try {
            LOG.info(`Uploading file: ${fileObj.filename}`);

            // Prepare file data for upload
            const uploadRequest = {
                id: session.get(APP_CONSTANTS.USERID).toString(),
                org: session.get(APP_CONSTANTS.USERORG).toString(),
                chat_filename: chatFilename,
                file_data: fileObj.bytes64,  // Send base64 encoded
                filename: fileObj.filename
            };

            LOG.info(`Sending upload request for ${fileObj.filename}...`);

            // Upload file using apiman (consistent with other API calls)
            const result = await apiman.rest(uploadAPI, "POST", uploadRequest, true);

            if (result?.result) {
                LOG.info(`File ${fileObj.filename} uploaded successfully`);
                uploadedFiles.push({
                    filename: result.stored_filename,
                    path: result.stored_abs_path,
                    mime_type: result.mime_type,
                    size: result.size
                });
            } else {
                LOG.error(`File upload failed for ${fileObj.filename}: ${result?.reason || 'Unknown error'}`);
            }
        } catch (err) {
            LOG.error(`File upload exception for ${fileObj.filename}: ${err?.message || err}`);
            console.error(err);
        }
    }

    LOG.info(`File upload complete. Uploaded ${uploadedFiles.length}/${files.length} files`);
    return uploadedFiles;
}

export const main = {initView, getAssistantResult};
