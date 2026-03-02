/**
 * @module chat-box
 * 
 * (C) 2023 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 * 
 * Provides a standard chatbox component. Can take Latex'ed Markdown
 * sent out by LLMs and format it to HTML.
 */

import katex from "./3p/katex-0.16.min.mjs";
import {i18n} from "/framework/js/i18n.mjs";
import {util} from "/framework/js/util.mjs";
import {marked} from "./3p/marked.esm.min.js";
import {router} from "/framework/js/router.mjs";
import {monkshu_component} from "/framework/js/monkshu_component.mjs";
import {chat_history} from "../chatHistory/chatHistory.mjs";
import {session} from "/framework/js/session.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";

const COMPONENT_PATH = util.getModulePathFromURL(import.meta.url), DEFAULT_MAX_ATTACH_SIZE = 4194304,
    DEFAULT_MAX_ATTACH_SIZE_ERROR = "File size is larger than allowed size",
    DEFAULT_MAX_ATTACHMENTS_ERROR = "Maximum attachments limit reached",
    DOWNLOAD_MSG_ON_HOVERING = "Download";

let MUSTACHE, last_message_id;
const MESSAGE_THOUGHTS_MAP = {};  // Store thoughts per message_id: { message_id: { thoughts, mime } }

async function elementConnected(host) {
    const ATTACHMENT_ALLOWED = host.getAttribute("attach")?.toLowerCase() == "true";
    const stt_flag = host.getAttribute("stt")?.toLowerCase() == "true", 
        tts_flag = host.getAttribute("tts")?.toLowerCase() == "true", greeting = host.getAttribute("greeting") || "";
	chat_box.setDataByHost(host, {COMPONENT_PATH, ATTACHMENT_ALLOWED: ATTACHMENT_ALLOWED?"true":undefined, 
        STT: stt_flag?"true":undefined, TTS: tts_flag?"true":undefined, GREETING: greeting });
    const memory = chat_box.getMemoryByHost(host); memory.FILES_ATTACHED = [];
    const typewriter = host.getAttribute("typewriter");
    memory.typewriter = typewriter ? (typewriter.toLowerCase() == "false" ? false : parseInt(host.getAttribute("typewriter"))) : false;
    MUSTACHE = await router.getMustache();
}

async function elementRendered(host) {
    const shadowRoot = chat_box.getShadowRootByHost(host);
    const textareaEdit = shadowRoot.querySelector("textarea#messagearea")
    textareaEdit.focus();

    if (!shadowRoot.host.dataset.preloaded) {
        shadowRoot.host.dataset.preloaded = "1";
        const contained = shadowRoot.querySelector("div#body") || shadowRoot; // any inner element works
        try {
            await preloadArchiveIfAny(contained);
        } catch (e) {
            console.warn("Preload archive failed:", e);
        }
    }
}

async function send(containedElement) {
    const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement), host = chat_box.getHostElement(containedElement);
    const userMessageArea = shadowRoot.querySelector("textarea#messagearea"), userPrompt = userMessageArea.value.trim();
    if (userPrompt == "") return;    // empty prompt, ignore

    const chatArchiveAppenderAPI = `${APP_CONSTANTS.API_PATH}/chatArchiveAppender`;
    const id = session.get(APP_CONSTANTS.USERID);
    const org = session.get(APP_CONSTANTS.USERORG);
    const ai_app = session.get(APP_CONSTANTS.FORCE_LOAD_VIEW);
    let curr_filename = session.get(APP_CONSTANTS.CHAT_FILENAME);

    if (!curr_filename) {
        let time = new Date().toISOString();
        curr_filename = `_${org}_${id}_${time}.ndjson`;
        session.set(APP_CONSTANTS.CHAT_FILENAME, curr_filename);
    }

    // disable send box and controls
    const divMessage = shadowRoot.querySelector("div#message"),
        buttonSendImg = shadowRoot.querySelector("img#send"),
        attachImg = shadowRoot.querySelector("img#attach"),
        checkBox = shadowRoot.querySelector("input#multiline");
    divMessage.classList.add("disabled"), checkBox.setAttribute("disabled", true);
    if (attachImg) attachImg.style.pointerEvents = "none";
    buttonSendImg.src = `${COMPONENT_PATH}/img/spinner.svg`; userMessageArea.readOnly = true;

    const message_id = `${Date.now()}${Math.floor(Math.random() * 1000) + 1}`; last_message_id = message_id;
    _insertAIRequest(shadowRoot, userMessageArea, userPrompt, message_id);

    const chatsession_id = session.get(APP_CONSTANTS.CHAT_SESSION_ID);
    const attachedFiles = _getMemory(containedElement).FILES_ATTACHED;
    const user_message_history_request = { role: 'user', message: userPrompt, chat_filename: curr_filename, id, org, ai_app, chatsession_id };

    // Upload files and store server references in the archive
    if (attachedFiles && attachedFiles.length > 0) {
        const uploadAPI = `${APP_CONSTANTS.API_PATH}/uploadChatFile`;
        const uploadedRefs = await Promise.all(attachedFiles.map(async f => {
            const res = await apiman.rest(uploadAPI, "POST",
                {id, org, chat_filename: curr_filename, filename: f.filename, file_data: f.bytes64}, true);
            return res?.result
                ? {filename: f.filename, fileid: f.fileid, stored_filename: res.stored_filename, stored_abs_path: res.stored_abs_path, mime_type: res.mime_type, size: res.size}
                : {filename: f.filename, fileid: f.fileid};
        }));
        user_message_history_request.files = uploadedRefs;
    }

    await apiman.rest(chatArchiveAppenderAPI, "POST", user_message_history_request, true);

    const onRequest = host.getAttribute("onrequest");
    const wrappedChatBox = {
        insertAIResponse: async (processedResult, msg_id=last_message_id) => {
            await _insertAIResponse(shadowRoot, processedResult[processedResult.ok?"response":"error"], processedResult.mime, msg_id);

            // Build history request with optional thoughts
            const ai_message_history_request = {
                role: 'assistant',
                message: processedResult[processedResult.ok?"response":"error"],
                chat_filename: curr_filename,
                id,
                org,
                ai_app
            };

            // Include thoughts if they were captured for this message
            if (MESSAGE_THOUGHTS_MAP[msg_id]) {
                ai_message_history_request.thoughts = MESSAGE_THOUGHTS_MAP[msg_id].thoughts;
                ai_message_history_request.thoughts_mime = MESSAGE_THOUGHTS_MAP[msg_id].mime;
                delete MESSAGE_THOUGHTS_MAP[msg_id];  // Clean up after storing
            }

            await apiman.rest(chatArchiveAppenderAPI, "POST", ai_message_history_request, true);
            await chat_history.refreshSidebarChats();
            if (!processedResult.ok) {
                buttonSendImg.onclick = ''; buttonSendImg.src = `${COMPONENT_PATH}/img/senddisabled.svg`;
            } else {
                buttonSendImg.src = `${COMPONENT_PATH}/img/send.svg`;
                divMessage.classList.remove("disabled"), checkBox.removeAttribute("disabled");
                if (attachImg) attachImg.style.pointerEvents = "";
                userMessageArea.readOnly = false;
            }
        },
        insertAIThoughts: (thoughts, thoughts_mime, msg_id=last_message_id) => {
            // Store thoughts for later inclusion in history
            MESSAGE_THOUGHTS_MAP[msg_id] = { thoughts, mime: thoughts_mime || "text/markdown" };
            // Also display them immediately
            return _insertAIThoughts(shadowRoot, thoughts, thoughts_mime, msg_id);
        },
        getCollapsibleSection: (title, content) => _getCollapsibleSection(containedElement, title, content),
        getAIContent: msg_id => _getAIResponseContent(shadowRoot, msg_id||last_message_id)||""
    };
    const requestProcessor = util.createAsyncFunction(`return await ${onRequest};`);
    requestProcessor({chatbox: wrappedChatBox, message_id, prompt: userPrompt, files: _getMemory(containedElement).FILES_ATTACHED});
}

/* === Preload archived chat into the chatbox === */
async function preloadArchiveIfAny(containedElement) {
    // Validate input
    if (!containedElement) {
        LOG.warn("preloadArchiveIfAny: containedElement is null/undefined");
        return;
    }

    const pre = session.get(APP_CONSTANTS.CHAT_HISTORY_CONVERSATION);
    if (!Array.isArray(pre) || !pre.length) return;

    // Clear it so we don't render twice on subsequent loads
    session.remove(APP_CONSTANTS.CHAT_HISTORY_CONVERSATION);

    // Get shadow root and validate
    const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement);
    if (!shadowRoot) {
        LOG.error("preloadArchiveIfAny: Failed to get shadowRoot from containedElement");
        return;
    }

    // Get and validate required elements
    const userMessageArea = shadowRoot.querySelector("textarea#messagearea");
    if (!userMessageArea) {
        LOG.error("preloadArchiveIfAny: textarea#messagearea not found in shadow DOM");
        return;
    }

    // Get and validate chat elements
    const chatStartDiv = shadowRoot.querySelector("div#start");
    const chatScroller = shadowRoot.querySelector("div#chatscroller");
    if (!chatScroller) {
        LOG.error("preloadArchiveIfAny: div#chatscroller not found in shadow DOM");
        return;
    }

    // Make the chat area visible (same as send() does)
    if (chatStartDiv) {
        chatStartDiv.classList.replace("visible", "hidden");
    }
    chatScroller.classList.replace("hidden", "visible");

    // Walk through objects and render
    let i = 0;
    while (i < pre.length) {
        const curr = pre[i] || {};
        const role = String(curr.role || curr.type || "").toLowerCase();
        const msg = String(curr.message || curr.content || "");

        if (role === "user" || role === "system") {
            // Create a new insertion div with user's message
            const message_id = `${Date.now()}${Math.floor(Math.random() * 1000) + 1}${i}`;
            _insertAIRequest(shadowRoot, userMessageArea, msg, message_id);

            // Display attached files if any
            if (curr.files && Array.isArray(curr.files) && curr.files.length > 0) {
                _displayArchivedFiles(shadowRoot, message_id, curr.files);
            }

            // Check if next message is assistant (pair them in same card)
            const next = pre[i + 1] || {};
            const nextRole = String(next.role || next.type || "").toLowerCase();
            const nextMsg = next.message || next.content || "";

            if (next && nextMsg && nextRole === "assistant") {
                // Fill in the AI response in the same insertion div
                await _insertAIResponse(shadowRoot, nextMsg, next.mime || "text/markdown", message_id);

                // Display thoughts if available
                if (next.thoughts) {
                    _insertAIThoughts(shadowRoot, next.thoughts, next.thoughts_mime || "text/markdown", message_id);
                }

                i += 2;
                continue;
            }

            // If no assistant follows, just show user's message row
            i += 1;
            continue;
        }

        if (role === "assistant") {
            // No preceding user: create a new insertion with empty user section and AI response
            const message_id = `${Date.now()}${Math.floor(Math.random() * 1000) + 1}${i}`;
            _insertAIRequest(shadowRoot, userMessageArea, "(Assistant)", message_id);
            await _insertAIResponse(shadowRoot, msg, curr.mime || "text/markdown", message_id);

            // Display thoughts if available
            if (curr.thoughts) {
                _insertAIThoughts(shadowRoot, curr.thoughts, curr.thoughts_mime || "text/markdown", message_id);
            }

            i += 1;
            continue;
        }

        // Unknown role: skip
        i += 1;
    }

    // Scroll to bottom when done
    if (chatScroller) chatScroller.scrollTop = chatScroller.scrollHeight;
}

async function startVoiceInput(containedElement) {
    console.log("STT: Triggered");

    const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement);
    const textarea = shadowRoot.querySelector("textarea#messagearea");
    const micButton = shadowRoot.querySelector("img#mic");
    const divMessage = shadowRoot.querySelector("div#message");
    const host = chat_box.getHostElement(containedElement);

    const sttAPI = `${APP_CONSTANTS.API_PATH}/voiceTools`;
    console.log("STT: API endpoint →", sttAPI);

    let mediaRecorder, audioChunks = [], stream;

    const showSpinner = () => {
        textarea.readOnly = true;
        divMessage.classList.add("disabled");
        micButton.dataset.originalSrc = micButton.src;
        micButton.src = `${COMPONENT_PATH}/img/spinner.svg`;
        micButton.classList.add("rotating");
    };
    const restoreMic = () => {
        textarea.readOnly = false;
        divMessage.classList.remove("disabled");
        micButton.src = micButton.dataset.originalSrc;
        micButton.classList.remove("rotating");
    };

    const handleRecordingStop = async () => {
        console.log("STT: Recording stopped, preparing request...");
        showSpinner(); 
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const audioBase64 = await _blobToBase64(audioBlob);
        stream.getTracks().forEach(t => t.stop()); 

        const request = { 
            service: "stt", 
            id: session.get(APP_CONSTANTS.USERID), 
            org: session.get(APP_CONSTANTS.USERORG), 
            audiofile: audioBase64 
        };

        try {
            const result = await apiman.rest(sttAPI, "POST", request, true);
            console.log("STT: API raw response →", result);

            const transcript = result?.text || "";
            if (result?.result && transcript.trim()) {
                textarea.value = transcript.trim();
                textarea.focus();
                console.log("STT: Transcription →", transcript);
            } else {
                console.error("STT: API returned no valid transcription");
                alert("Voice recognition failed: " + (result?.reason || "Unknown error"));
            }
        } catch (err) {
            console.error("STT API Error:", err);
            alert("STT service unavailable");
        } finally {
            restoreMic(); 
        }
    };

    micButton.onmousedown = async () => {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = handleRecordingStop;

            mediaRecorder.start();
            console.log("STT: Recording started (hold mic to record)...");
        } catch (err) {
            console.error("Voice input error:", err);
            alert("Microphone access failed");
        }
    };

    micButton.onmouseup = micButton.ontouchend = () => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
            console.log("STT: Recording stopped by user.");
        }
    };
}

async function playTTS(containedElement) {
    console.log("TTS: Triggered");
    try {
        const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement);
        const aiResponseEl = containedElement.closest("span#aicontentholder")?.querySelector("span#airesponse");

        if (!aiResponseEl) {
            console.error("TTS: AI response element not found");
            return;
        }

        const text = aiResponseEl.innerText.trim();
        if (!text) {
            console.warn("TTS: No text available to synthesize");
            return;
        }

        const host = chat_box.getHostElement(containedElement);
        const ttsAPI =  `${APP_CONSTANTS.API_PATH}/voiceTools`;
        console.log("TTS: API endpoint →", ttsAPI);

        const result = await apiman.rest(ttsAPI, "POST", { service: "tts",id: session.get(APP_CONSTANTS.USERID), org: session.get(APP_CONSTANTS.USERORG), text }, true);
        console.log("TTS: API raw response →", result);

        if (!result?.result) {
            console.error("TTS: API returned failure", result);
            alert("TTS playback failed: " + (result?.reason || "Unknown error"));
            return;
        }

        let audioBase64 = result.audiofile;
        if (!audioBase64 && result.response?.audiofile) {
            audioBase64 = result.response.audiofile;
        }

        const onResult = host.getAttribute("onresult");
        if (onResult) {
            const resultProcessor = util.createAsyncFunction(`return await ${onResult};`);
            const processedResult = await resultProcessor({ chatbox: this, result });
            if (processedResult?.ok && processedResult.response?.audiofile) {
                audioBase64 = processedResult.response.audiofile;
            }
        }

        if (audioBase64) {
            const audioSrc = `data:audio/mp3;base64,${audioBase64}`;
            const audio = new Audio(audioSrc);
            audio.play().catch(err => console.error("TTS: Playback error", err));
            console.log("TTS: Playing audio...");
        } else {
            console.error("TTS: No audiofile found in API response");
            alert("TTS playback failed: Missing audio data");
        }
    } catch (err) {
        console.error("TTS Error:", err);
        alert("TTS service unavailable");
    }
}

function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function attach(containedElement) {
    const memory = _getMemory(containedElement), host = chat_box.getHostElement(containedElement);
    const maxattachments = host.getAttribute("maxattachments"), accepts = host.getAttribute("attachaccepts") || "*/*";
    if (maxattachments && (memory.FILES_ATTACHED.length >= parseInt(maxattachments))) {
        alert(host.getAttribute("maxattachmentserror")||DEFAULT_MAX_ATTACHMENTS_ERROR);
        return;
    }

    const {name, type, data} = await util.uploadAFile(accepts, "binary",
        host.getAttribute("maxattachsize")||DEFAULT_MAX_ATTACH_SIZE, host.getAttribute("maxattachsizeerror")||DEFAULT_MAX_ATTACH_SIZE_ERROR);
    const bytes64 = await util.bufferToBase64(data), fileid = name.replaceAll(/[.\s]/g,"_")+"_"+Date.now();
    const FILE_EXT = name.split(".").pop().toLowerCase();
    const fileObject = {filename: name, type, bytes64, fileid, FILE_EXT};
    memory.FILES_ATTACHED.push(fileObject);

    const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement);
    const insertionHTML = shadowRoot.querySelector("template#fileattachment_insertion_template").innerHTML.trim();   // clone
    const renderedHTML = MUSTACHE.render(insertionHTML, fileObject);
    const tempNode = document.createElement("template"); tempNode.innerHTML = renderedHTML;
    const newNode = tempNode.content.cloneNode(true);
    newNode.querySelector("span.fileicon").title = `${DOWNLOAD_MSG_ON_HOVERING} ${name}`;

    // replaces placeholder with svg template
    _renderFileIcon(newNode.querySelector("span#fileiconplaceholder"), shadowRoot, FILE_EXT);

    const insertionNode = shadowRoot.querySelector("span#attachedfiles");
    insertionNode.appendChild(newNode);
}

async function detach(containedElement, fileid) {
    const memory = _getMemory(containedElement);
    memory.FILES_ATTACHED = memory.FILES_ATTACHED.filter(fileobject => fileobject.fileid != fileid);
    const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement);
    const insertionNode = shadowRoot.querySelector("span#attachedfiles");
    const nodeToDelete = insertionNode.querySelector(`span#${fileid}`);
    if (nodeToDelete) insertionNode.removeChild(nodeToDelete);
}

async function saveAsWord(elementAIResponse) {
    if ((!elementAIResponse) || ((elementAIResponse.dataset.originalcontent_mime != "text/markdown") && 
        (elementAIResponse.dataset.originalcontent_mime != "text/plain"))) return; // we can't convert anything other than MD or plain text
    
    try {
        const mdContentWithHTML = elementAIResponse.dataset.originalcontent;
        const mdContentWithoutHTML = mdContentWithHTML.replace(/<[^>]*>/g, '');    // remove HTML tags from markdown as they don't parse
        const mdModule = await import(`${COMPONENT_PATH}/3p/markdown_docx_1.4.3.mjs`);
        const docxTree = await mdModule.markdownDocx(mdContentWithoutHTML);
        const docx = await import(`${COMPONENT_PATH}/3p/docx_9.5.1.mjs`);
        const docxArrayBuffer = await docx.Packer.toArrayBuffer(docxTree);
        const fileName = `chat_${new Date(Date.now()).toLocaleString().replaceAll(' ', '_').replaceAll(',', '')}.docx`;
        util.downloadFile(docxArrayBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName);
    } catch (err) {
        LOG.error(err);
    }
}

function _getCollapsibleSection(shadowRoot, title, content) {
    // Validate inputs
    if (!shadowRoot) {
        LOG.error("_getCollapsibleSection: shadowRoot is null/undefined");
        return "";
    }
    if (!title) title = "";
    if (!content) content = "";

    const templateEl = shadowRoot.querySelector("template#collapsible_content_template");
    if (!templateEl) {
        LOG.error("_getCollapsibleSection: template#collapsible_content_template not found");
        return "";
    }

    const insertionTemplate = templateEl.innerHTML;
    const rendered = MUSTACHE.render(insertionTemplate, {title, content});
    return rendered;
}

function _detachAllFiles(shadowRoot, clearAttachedFileMemory) {
    // Validate shadowRoot
    if (!shadowRoot) {
        LOG.warn("_detachAllFiles: shadowRoot is null/undefined");
        return;
    }

    const containedElement = shadowRoot.querySelector("div#body");
    if (clearAttachedFileMemory && containedElement) {
        const memory = _getMemory(containedElement);
        if (memory) {
            memory.FILES_ATTACHED = [];
        }
    }

    const insertionNode = shadowRoot.querySelector("span#attachedfiles");
    if (!insertionNode) {
        LOG.warn("_detachAllFiles: span#attachedfiles not found");
        return;
    }

    while (insertionNode.firstChild) {
        insertionNode.removeChild(insertionNode.firstChild);
    }
}

function _insertAIRequest(shadowRoot, userMessageArea, userPrompt, message_id) {
    // Validate inputs
    if (!shadowRoot) {
        LOG.error("_insertAIRequest: shadowRoot is null/undefined");
        return;
    }
    if (!userMessageArea) {
        LOG.error("_insertAIRequest: userMessageArea is null/undefined");
        return;
    }
    if (!message_id) {
        LOG.error("_insertAIRequest: message_id is null/undefined");
        return;
    }

    const insertionTemplate = shadowRoot.querySelector("template#chatresponse_insertion_template");
    if (!insertionTemplate) {
        LOG.error("_insertAIRequest: template#chatresponse_insertion_template not found");
        return;
    }

    const templateContent = insertionTemplate.content.cloneNode(true);
    const insertion = templateContent.querySelector("div.insertiondiv");
    if (!insertion) {
        LOG.error("_insertAIRequest: div.insertiondiv not found in template");
        return;
    }

    insertion.id = `c${message_id}`;
    const elementUserprompt = insertion.querySelector("span.userprompt");
    if (!elementUserprompt) {
        LOG.error("_insertAIRequest: span.userprompt not found in template");
        return;
    }

    const bodyDiv = shadowRoot.querySelector("div#body");
    const memory = bodyDiv ? chat_box.getMemoryByContainedElement(bodyDiv) : null;
    const attachedFiles = memory?.FILES_ATTACHED || [];
    elementUserprompt.textContent = userPrompt;
    if (attachedFiles.length > 0) {
        const filesDiv = document.createElement("div"); filesDiv.className = "user-files";
        const fileIconTemplateHTML = shadowRoot.querySelector("template#userfile_icon_template").innerHTML.trim();
        for (const file of attachedFiles) {
            const fileIconrenderedHTML = MUSTACHE.render(fileIconTemplateHTML, file);
            const tempNode = document.createElement("template"); tempNode.innerHTML = fileIconrenderedHTML;
            const icon = tempNode.content.cloneNode(true);
            const userFileSpan = icon.querySelector("span.user-file");
            userFileSpan.title = `${DOWNLOAD_MSG_ON_HOVERING} ${file.filename}`;
            userFileSpan._fileObject = file;

            // replaces placeholder with svg template
            _renderFileIcon(icon.querySelector("span#fileiconplaceholder"), shadowRoot, file.FILE_EXT);

            filesDiv.appendChild(icon);
        }
        elementUserprompt.appendChild(filesDiv);
    }
    // Append insertion to chat area
    const chatMainArea = shadowRoot.querySelector("div#chatmainarea");
    if (!chatMainArea) {
        LOG.error("_insertAIRequest: div#chatmainarea not found");
        return;
    }
    chatMainArea.appendChild(insertion);

    // Scroll to the bottom
    const chatScroller = shadowRoot.querySelector("div#chatscroller");
    if (!chatScroller) {
        LOG.error("_insertAIRequest: div#chatscroller not found");
        return;
    }
    chatScroller.scrollTop = chatScroller.scrollHeight;

    // Hide the startup logo and messages and switch to chat if this is the first message
    const startDiv = shadowRoot.querySelector("div#start");
    if (startDiv && startDiv.classList.contains("visible")) {
        startDiv.classList.replace("visible", "hidden");
        chatScroller.classList.replace("hidden", "visible");
    }
    
    // clear the message area and attached files to prepare for the next message
    userMessageArea.placeholder = "";   // disable placeholders after the initial starter prompt
    userMessageArea.value = ""; // clear text area for the next prompt
    _detachAllFiles(shadowRoot, false);  // clear file attachments
}

/**
 * Display archived files in a user message when loading chat history
 */
function _displayArchivedFiles(shadowRoot, message_id, files) {
    const insertion = shadowRoot.querySelector(`div.insertiondiv#c${message_id}`);
    if (!insertion) return;

    const userpromptSpan = insertion.querySelector("span.userprompt");
    if (!userpromptSpan) return;

    // Create files container
    const filesDiv = document.createElement("div");
    filesDiv.className = "user-files";

    // Add each file
    for (const file of files) {
        const fileSpan = document.createElement("span");
        fileSpan.className = "user-file";

        const icon = document.createElement("img");
        icon.id = "fileicon";
        icon.src = `${COMPONENT_PATH}/img/file.svg`;

        const nameSpan = document.createElement("span");
        nameSpan.id = "name";
        nameSpan.textContent = file.filename || file.stored_filename || "file";

        fileSpan.appendChild(icon);
        fileSpan.appendChild(nameSpan);
        filesDiv.appendChild(fileSpan);
    }

    userpromptSpan.appendChild(filesDiv);
}

function _insertAIThoughts(shadowRoot, thoughts, thoughts_mime="text/markdown", message_id=last_message_id) {
    const insertion = shadowRoot.querySelector(`div.insertiondiv#c${message_id}`);
    if (!insertion) return;
    const elementCollapsibleContainer = insertion.querySelector("div.collapsiblecontainer#aithoughtsection");
    elementCollapsibleContainer.classList.add("visible");
    const elementAIThoughtsParent = insertion.querySelector("div.collapsiblecontent#aithoughtcontent"); 
    let elementAIThought = insertion.querySelector("div.collapsiblecontent#aithoughtcontent div.thought"); 
    if (elementAIThought.innerHTML.trim() != "") {  // need to add a new element
        elementAIThought = elementAIThought.cloneNode(true); elementAIThoughtsParent.appendChild(elementAIThought); }
    const htmlContent = thoughts_mime=="text/markdown" ? _latexedMarkdownToHTML(thoughts) : thoughts;
    elementAIThought.innerHTML = htmlContent;
    const chatScroller = shadowRoot.querySelector("div#chatscroller");
    chatScroller.scrollTop = chatScroller.scrollHeight;
}

async function _insertAIResponse(shadowRoot, aiResponse, aiReponseMime="text/markdown", message_id=last_message_id) {
    // insert current prompt and/or reply
    const insertion = shadowRoot.querySelector(`div.insertiondiv#c${message_id}`);
    if (!insertion) return;
    const chatScroller = shadowRoot.querySelector("div#chatscroller");
    const memory = chat_box.getMemoryByContainedElement(insertion), typewriter = memory.typewriter;
    const elementAIResponse = insertion.querySelector("span.airesponse"); 
    const htmlContent = aiReponseMime=="text/markdown" ? _latexedMarkdownToHTML(aiResponse): aiResponse;
    const insertionTemplate = shadowRoot.querySelector("template#chatresponse_insertion_template").content.cloneNode(true);   
    if (typewriter) await _typewriterWriteText(elementAIResponse, htmlContent, chatScroller, typewriter); 
    else elementAIResponse.innerHTML=htmlContent;
    elementAIResponse.innerHTML += insertionTemplate.querySelector("span.controls").outerHTML;
    elementAIResponse.dataset.content = `<!doctype html>\n${htmlContent}\n</html>`;
    elementAIResponse.dataset.content_mime = "text/html";
    elementAIResponse.dataset.originalcontent = aiResponse;
    elementAIResponse.dataset.originalcontent_mime = aiReponseMime;
    const elementControlsWord = insertion.querySelector("img#controlsword");
    if (aiReponseMime.toLowerCase() == "text/markdown") elementControlsWord.classList.remove("hidden");

    // we are no longer thinking, so the label should now be thoughts, not thinking
    const elementThinkingSectionHeaderElement = insertion.querySelector("div#aithoughtsection div.collapsiblebutton");
    if (elementThinkingSectionHeaderElement) {
        elementThinkingSectionHeaderElement.innerHTML = await i18n.get("ChatboxThoughtsLabel");
        elementThinkingSectionHeaderElement.classList.remove("rollinghighlight");
    }

    // scroll to the bottom
    chatScroller.scrollTop = chatScroller.scrollHeight;

    // forget attached files
    _detachAllFiles(shadowRoot, true);  // clear file attachments
}

function _getAIResponseContent(shadowRoot, message_id) {
    const insertion = shadowRoot.querySelector(`div.insertiondiv#c${message_id}`);
    if (!insertion) return "";
    const elementAIResponse = insertion.querySelector("span.airesponse");
    return elementAIResponse.dataset.originalcontent;
}

function _latexedMarkdownToHTML(text) {
    try {
        const latexBoundariedText = text.replace(/\\\[([\s\S]*?)\\\]/g, '<div class=\"maths\">$1</div>');
        let html = marked.parse(latexBoundariedText);
        const regex = /<div class=\"maths\">([\s\S]*?)<\/div>/g;
        let match; while ((match = regex.exec(html)) !== null) {
            const mathMLText = katex.renderToString(match[1].trim(), {displayMode: true, output: "mathml", throwOnError: false, strict: false});
            html = html.replace(match[0], mathMLText);
        }
        return html;
    } catch (err) {
        LOG.error(`Markdown conversion error: ${err}, returning original text`);
        return text;
    }
}

async function _typewriterWriteText(element, html, scroller, delay=10) {  // AI generated using stack overflow AI, then manually recoded
    const _sleep = ms => new Promise(r => setTimeout(r, ms));
    async function _revealNode(node, parent) {
        if (node.nodeType === Node.TEXT_NODE) {
            // create a live text node and append characters to it
            const typewriterTextNode = document.createTextNode('');
            parent.appendChild(typewriterTextNode);
            for (let i = 0; i < node.data.length; i++) {
                typewriterTextNode.data += node.data[i];
                await _sleep(delay);
            }
            scroller.scrollTop = scroller.scrollHeight; // auto scroll to show new content
        } else if (node.nodeType === Node.ELEMENT_NODE) {       // ignore other node types (comments, etc.)
            // create element shell (without children) so styling/structure is present immediately
            const el = document.createElement(node.tagName);
            for (const attr of node.attributes) el.setAttribute(attr.name, attr.value); // copy attributes
            parent.appendChild(el);
            for (const child of node.childNodes) await _revealNode(child, el); // reveal children into the new element
        }
    }

    const dummyTemplate = document.createElement("template"); dummyTemplate.innerHTML = html;
    element.innerHTML = ""; for (const child of dummyTemplate.content.childNodes) await _revealNode(child, element);
}

// This function takes the svg template from html and renders the text inside and replaces the placeholder with the rendered svg
function _renderFileIcon(placeholder, shadowRoot, FILE_EXT) {
    const svgHTML = MUSTACHE.render(shadowRoot.querySelector("template#fileicon_svg_template").innerHTML, {FILE_EXT});
    const t = document.createElement("template"); t.innerHTML = svgHTML;
    placeholder.replaceWith(t.content.cloneNode(true));
}

const _getMemory = containedElement => chat_box.getMemoryByContainedElement(containedElement);

async function downloadAttachedFile(element) {
    const target = element.closest(".fileicon[id]") || element.closest(".user-file[id]") || element;
    const memory = chat_box.getMemoryByContainedElement(element);
    const fileObject = memory.FILES_ATTACHED.find(f => f.fileid === target.id) || target._fileObject;
    if (!fileObject) return;
    const {bytes64, type, filename} = fileObject;
    const binary = Uint8Array.from(atob(bytes64), c => c.charCodeAt(0));
    util.downloadFile(binary, type, filename);
}

export const chat_box = {trueWebComponentMode: true, elementConnected, elementRendered, send, attach,
    detach, downloadAttachedFile, saveAsWord, startVoiceInput:(()=>{})(), playTTS: (()=>{})()}
monkshu_component.register("chat-box", `${COMPONENT_PATH}/chat-box.html`, chat_box);
