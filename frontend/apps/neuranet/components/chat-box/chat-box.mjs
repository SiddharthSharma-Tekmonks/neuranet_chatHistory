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
import {initSpeech, SPEECH_MEMORY_DEFAULTS, startVoiceInput, playTTS, stopTTS, cancelCurrentTTS} from "./chat-box-speech.mjs";

const COMPONENT_PATH = util.getModulePathFromURL(import.meta.url), DEFAULT_MAX_ATTACH_SIZE = 4194304,
    DEFAULT_MAX_ATTACH_SIZE_ERROR = "File size is larger than allowed size",
    DEFAULT_MAX_ATTACHMENTS_ERROR = "Maximum attachments limit reached",
    DOWNLOAD_MSG_ON_HOVERING = "Download";

let MUSTACHE, last_message_id;

async function elementConnected(host) {
    const ATTACHMENT_ALLOWED = host.getAttribute("attach")?.toLowerCase() == "true";
    const stt_flag = host.getAttribute("stt")?.toLowerCase() == "true", 
        tts_flag = host.getAttribute("tts")?.toLowerCase() == "true", greeting = host.getAttribute("greeting") || "";
	chat_box.setDataByHost(host, {COMPONENT_PATH, ATTACHMENT_ALLOWED: ATTACHMENT_ALLOWED?"true":undefined, 
        STT: stt_flag?"true":undefined, TTS: tts_flag?"true":undefined, GREETING: greeting });
    const memory = chat_box.getMemoryByHost(host);
    memory.FILES_ATTACHED = [];
    memory.speech = {...SPEECH_MEMORY_DEFAULTS};
    const typewriter = host.getAttribute("typewriter");
    memory.typewriter = typewriter ? (typewriter.toLowerCase() == "false" ? false : parseInt(host.getAttribute("typewriter"))) : false;
    MUSTACHE = await router.getMustache();
}

async function elementRendered(host) {
    const shadowRoot = chat_box.getShadowRootByHost(host);
    const textareaEdit = shadowRoot.querySelector("textarea#messagearea");
    textareaEdit.focus();
}

async function send(containedElement) {
    const shadowRoot = chat_box.getShadowRootByContainedElement(containedElement), host = chat_box.getHostElement(containedElement);
    const userMessageArea = shadowRoot.querySelector("textarea#messagearea"), userPrompt = userMessageArea.value.trim();
    if (userPrompt == "") return;    // empty prompt, ignore

    const memory = _getMemory(containedElement);
    if (memory?.speech?.isListening && memory.speech.recognition) {
        delete userMessageArea.dataset.sttBaseText;  // prevent _onSpeechEnd from repopulating the textarea after send clears it
        memory.speech.finalTranscript = "";
        try { memory.speech.recognition.stop(); } catch (err) {}
    }

    if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending || memory?.speech?.ttsIsPaused) {
        cancelCurrentTTS(memory);
    }

    // disable send box and controls
    const divMessage = shadowRoot.querySelector("div#message"),
        buttonSendImg = shadowRoot.querySelector("img#send"),
        attachImg = shadowRoot.querySelector("img#attach"),
        micImg = shadowRoot.querySelector("img#mic"),
        checkBox = shadowRoot.querySelector("input#multiline");
    divMessage.classList.add("disabled"), checkBox.setAttribute("disabled", true);
    if (attachImg) attachImg.style.pointerEvents = "none";
    if (micImg) micImg.style.pointerEvents = "none";
    buttonSendImg.src = `${COMPONENT_PATH}/img/spinner.svg`; userMessageArea.readOnly = true;

    // insert the user's message
    const message_id = `${Date.now()}${Math.floor(Math.random() * 1000) + 1}`; last_message_id = message_id;
    _insertAIRequest(shadowRoot, userMessageArea, userPrompt, message_id);
    
    // send the message to the backend to get a response
    const onRequest = host.getAttribute("onrequest"); 
    const wrappedChatBox = {
        insertAIResponse: async (processedResult, message_id=last_message_id) => {
            await _insertAIResponse(shadowRoot, processedResult[processedResult.ok?"response":"error"], processedResult.mime, message_id);
            if (!processedResult.ok) {  // sending more messages is now disabled as this chat is dead due to error
                buttonSendImg.onclick = ''; buttonSendImg.src = `${COMPONENT_PATH}/img/senddisabled.svg`;
            } else { // enable sending more messages
                buttonSendImg.src = `${COMPONENT_PATH}/img/send.svg`;
                divMessage.classList.remove("disabled"), checkBox.removeAttribute("disabled");
                if (attachImg) attachImg.style.pointerEvents = "";
                if (micImg) micImg.style.pointerEvents = "";
                userMessageArea.readOnly = false;
            }   
        },
        insertAIThoughts: (thoughts, thoughts_mime, message_id=last_message_id) => _insertAIThoughts(shadowRoot, thoughts, thoughts_mime, message_id),
        getCollapsibleSection: (title, content) => _getCollapsibleSection(shadowRoot, title, content),
        getAIContent: message_id => _getAIResponseContent(shadowRoot, message_id=last_message_id)||""
    };
    const requestProcessor = util.createAsyncFunction(`return await ${onRequest};`);
    requestProcessor({chatbox: wrappedChatBox, message_id, prompt: userPrompt, files: _getMemory(containedElement).FILES_ATTACHED});
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
    const insertionTemplate = shadowRoot.querySelector("template#collapsible_content_template").innerHTML;   
    const rendered = MUSTACHE.render(insertionTemplate, {title, content});
    return rendered;
}

function _detachAllFiles(shadowRoot, clearAttachedFileMemory) {
    const containedElement = shadowRoot.querySelector("div#body");
    if (clearAttachedFileMemory) {const memory = _getMemory(containedElement); memory.FILES_ATTACHED = [];}
    const insertionNode = shadowRoot.querySelector("span#attachedfiles");
    while (insertionNode.firstChild) insertionNode.removeChild(insertionNode.firstChild);
}

function _insertAIRequest(shadowRoot, userMessageArea, userPrompt, message_id) {
    const insertionTemplate = shadowRoot.querySelector("template#chatresponse_insertion_template").content.cloneNode(true);   
    const insertion = insertionTemplate.querySelector("div.insertiondiv"); insertion.id = `c${message_id}`; 
    const elementUserprompt = insertion.querySelector("span.userprompt");
    const memory = chat_box.getMemoryByContainedElement(shadowRoot.querySelector("div#body"));
    const attachedFiles = memory.FILES_ATTACHED || [];
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
    shadowRoot.querySelector("div#chatmainarea").appendChild(insertion);

    // scroll to the bottom
    const chatScroller = shadowRoot.querySelector("div#chatscroller");
    chatScroller.scrollTop = chatScroller.scrollHeight;

    // hide the startup logo and messages and switch to chat if this is the first message
    if (shadowRoot.querySelector("div#start").classList.contains("visible")) {   
        shadowRoot.querySelector("div#start").classList.replace("visible", "hidden");
        chatScroller.classList.replace("hidden", "visible");  
    }
    
    // clear the message area and attached files to prepare for the next message
    userMessageArea.placeholder = "";   // disable placeholders after the initial starter prompt
    userMessageArea.value = ""; // clear text area for the next prompt
    _detachAllFiles(shadowRoot, false);  // clear file attachments
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

export const chat_box = {
    trueWebComponentMode: true,
    elementConnected,
    elementRendered,
    send,
    attach,
    detach,
    downloadAttachedFile,
    saveAsWord,
    startVoiceInput,
    playTTS,
    stopTTS
};
initSpeech(COMPONENT_PATH, chat_box);
monkshu_component.register("chat-box", `${COMPONENT_PATH}/chat-box.html`, chat_box);
