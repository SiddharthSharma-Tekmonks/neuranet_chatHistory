/**
 * @module chat-box-speech
 *
 * STT (speech-to-text) and TTS (text-to-speech) helpers for the chat-box component.
 * Call initSpeech(componentPath, chat_box) once after the chat_box export is defined.
 *
 * (C) 2023 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

let COMPONENT_PATH, _chat_box;

/** Must be called once, after the chat_box export object is available. */
export function initSpeech(componentPath, chat_box) {
    COMPONENT_PATH = componentPath;
    _chat_box = chat_box;
}

/** Default values for memory.speech — spread into memory.speech in elementConnected. */
export const SPEECH_MEMORY_DEFAULTS = {
    recognition: null,
    isListening: false,
    finalTranscript: "",
    currentUtterance: null,
    speakingButton: null,
    ttsText: "",
    ttsPausedAt: null,
    ttsIsPaused: false
};

// ─── STT ────────────────────────────────────────────────────────────────────

function _getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function _setMicListeningState(button, listening) {
    if (!button) return;
    button.dataset.listening = listening ? "true" : "false";
    button.style.opacity = listening ? "0.6" : "";
    button.title = listening ? "Stop voice input" : "Start voice input";
}

/** Creates and configures a SpeechRecognition instance. */
function _initRecognition(host, Ctor) {
    const recognition = new Ctor();
    recognition.lang = host.getAttribute("speechlang") || document.documentElement.lang || navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    if ("maxAlternatives" in recognition) recognition.maxAlternatives = 1;
    return recognition;
}

/** Merges interim + final STT results into the textarea. */
function _onSpeechResult(event, memory, textarea) {
    let interimTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) memory.speech.finalTranscript += `${transcript} `;
        else interimTranscript += transcript;
    }
    const baseText = textarea.dataset.sttBaseText ?? textarea.value;
    textarea.value = `${baseText}${baseText && (memory.speech.finalTranscript || interimTranscript) ? " " : ""}${memory.speech.finalTranscript}${interimTranscript}`
        .replace(/\s+/g, " ").trim();
    textarea.focus();
}

/** Cleans up STT state when recognition ends. */
function _onSpeechEnd(memory, micButton, textarea) {
    const baseText = textarea.dataset.sttBaseText ?? textarea.value;
    textarea.value = `${baseText}${baseText && memory.speech.finalTranscript ? " " : ""}${memory.speech.finalTranscript}`
        .replace(/\s+/g, " ").trim();
    delete textarea.dataset.sttBaseText;
    memory.speech.isListening = false;
    memory.speech.recognition = null;
    memory.speech.finalTranscript = "";
    _setMicListeningState(micButton, false);
    textarea.focus();
}

export async function startVoiceInput(containedElement) {
    const shadowRoot = _chat_box.getShadowRootByContainedElement(containedElement);
    const host = _chat_box.getHostElement(containedElement);
    const memory = _chat_box.getMemoryByContainedElement(containedElement);
    const textarea = shadowRoot.querySelector("textarea#messagearea");
    const micButton = shadowRoot.querySelector("img#mic");

    const Ctor = _getSpeechRecognitionCtor();
    if (!Ctor) {
        alert("Speech-to-text is not supported in this browser.");
        return;
    }

    if (memory?.speech?.isListening && memory.speech.recognition) {
        try { memory.speech.recognition.stop(); } catch (err) {}
        return;
    }

    const recognition = _initRecognition(host, Ctor);
    if (!recognition) return;

    memory.speech.recognition = recognition;
    memory.speech.isListening = true;
    memory.speech.finalTranscript = "";
    _setMicListeningState(micButton, true);

    recognition.onresult = event => _onSpeechResult(event, memory, textarea);
    recognition.onerror = event => {
        if (event.error !== "no-speech" && event.error !== "aborted") console.error("Speech recognition error:", event.error);
    };
    recognition.onend = () => _onSpeechEnd(memory, micButton, textarea);

    textarea.dataset.sttBaseText = textarea.value.trim();
    try {
        recognition.start();
    } catch (err) {
        console.error("Unable to start speech recognition:", err);
        delete textarea.dataset.sttBaseText;
        memory.speech.isListening = false;
        memory.speech.recognition = null;
        _setMicListeningState(micButton, false);
        alert("Could not start voice input.");
    }
}

// ─── TTS ────────────────────────────────────────────────────────────────────

function _normalizeSpeechText(text = "") {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[.*?\]\(.*?\)/g, " ")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .replace(/[*_>#~]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Sets the visual state of the TTS play/pause button and shows/hides the stop button.
 * state: 'idle' | 'speaking' | 'paused'
 */
function _setTTSButtonState(button, state) {
    if (!button) return;
    const iconMap  = { idle: "speaker.svg", speaking: "pause.svg", paused: "speaker.svg" };
    const titleMap = { idle: "Play audio",  speaking: "Pause audio", paused: "Resume audio" };
    button.src = `${COMPONENT_PATH}/img/${iconMap[state]}`;
    button.title = titleMap[state];
    button.dataset.ttsstate = state;
    button.style.opacity = state === "paused" ? "0.5" : "";
    const stopBtn = button.closest("span.controls")?.querySelector("img.tts-stop");
    if (stopBtn) stopBtn.classList.toggle("hidden", state === "idle");
}

/** Cancels any in-progress or paused TTS and fully resets TTS memory state. */
export function cancelCurrentTTS(memory) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
    if (memory?.speech?.speakingButton) _setTTSButtonState(memory.speech.speakingButton, "idle");
    if (memory?.speech) {
        memory.speech.currentUtterance = null;
        memory.speech.speakingButton = null;
        memory.speech.ttsText = "";
        memory.speech.ttsPausedAt = null;
        memory.speech.ttsIsPaused = false;
    }
}

/**
 * Detects the dominant non-Latin script in text and returns its BCP 47 language tag,
 * or null if the text is predominantly Latin (English, etc.).
 * Samples the first 300 characters for performance.
 */
function _detectTextLanguage(text) {
    const sample = text.slice(0, 300);
    const scripts = [
        { re: /[\u0600-\u06FF]/g, lang: "ar"    },  // Arabic
        { re: /[\u0590-\u05FF]/g, lang: "he"    },  // Hebrew
        { re: /[\u0900-\u097F]/g, lang: "hi"    },  // Devanagari → Hindi
        { re: /[\u0980-\u09FF]/g, lang: "bn"    },  // Bengali
        { re: /[\u0A80-\u0AFF]/g, lang: "gu"    },  // Gujarati
        { re: /[\u0B00-\u0B7F]/g, lang: "or"    },  // Odia
        { re: /[\u0B80-\u0BFF]/g, lang: "ta"    },  // Tamil
        { re: /[\u0C00-\u0C7F]/g, lang: "te"    },  // Telugu
        { re: /[\u0C80-\u0CFF]/g, lang: "kn"    },  // Kannada
        { re: /[\u0D00-\u0D7F]/g, lang: "ml"    },  // Malayalam
        { re: /[\u0E00-\u0E7F]/g, lang: "th"    },  // Thai
        { re: /[\u0400-\u04FF]/g, lang: "ru"    },  // Cyrillic → Russian
        { re: /[\u0370-\u03FF]/g, lang: "el"    },  // Greek
        { re: /[\u3040-\u309F\u30A0-\u30FF]/g, lang: "ja" },  // Hiragana/Katakana → Japanese
        { re: /[\uAC00-\uD7AF\u1100-\u11FF]/g,  lang: "ko" },  // Hangul → Korean
        { re: /[\u4E00-\u9FFF\u3400-\u4DBF]/g,  lang: "zh-CN" },  // CJK → Chinese (default)
    ];

    let best = null, bestCount = 0;
    for (const {re, lang} of scripts) {
        const count = (sample.match(re) || []).length;
        if (count > bestCount) { bestCount = count; best = lang; }
    }

    // Japanese wins over generic CJK when kana is present
    const kanaCount = (sample.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    if (best === "zh-CN" && kanaCount > 0) best = "ja";

    // Require at least 5% of the sample to be the detected script to avoid false positives
    const threshold = Math.max(3, sample.replace(/\s/g, "").length * 0.05);
    return bestCount >= threshold ? best : null;
}

/** Creates and configures a SpeechSynthesisUtterance for the given text. */
function _buildTTSUtterance(text, host) {
    const utterance = new SpeechSynthesisUtterance(text);
    const detectedLang = _detectTextLanguage(text);
    utterance.lang = detectedLang || host.getAttribute("speechlang") || document.documentElement.lang || navigator.language || "en-US";
    const preferredVoiceName = host.getAttribute("ttsvoice");
    if (preferredVoiceName) {
        const match = window.speechSynthesis.getVoices().find(v => v.name === preferredVoiceName);
        if (match) utterance.voice = match;
    }
    const rate = parseFloat(host.getAttribute("ttsrate"));
    const pitch = parseFloat(host.getAttribute("ttspitch"));
    if (!Number.isNaN(rate)) utterance.rate = rate;
    if (!Number.isNaN(pitch)) utterance.pitch = pitch;
    return utterance;
}

/** Resets TTS playback state and returns the button to idle. */
function _resetTTSPlaybackState(element, memory) {
    _setTTSButtonState(element, "idle");
    memory.speech.currentUtterance = null;
    memory.speech.speakingButton = null;
    memory.speech.ttsText = "";
    memory.speech.ttsPausedAt = null;
}

/**
 * Starts speaking from charOffset into memory.speech.ttsText.
 * Wires up boundary tracking, end, and error handlers.
 */
function _startTTSFromOffset(charOffset, element, memory) {
    const host = _chat_box.getHostElement(element);
    const text = memory.speech.ttsText.slice(charOffset);
    if (!text.trim()) { cancelCurrentTTS(memory); return; }

    const utterance = _buildTTSUtterance(text, host);

    utterance.onboundary = event => { memory.speech.ttsPausedAt = charOffset + event.charIndex; };

    utterance.onend = () => {
        if (memory.speech.ttsIsPaused) return;  // user paused — don't reset
        _resetTTSPlaybackState(element, memory);
    };

    utterance.onerror = err => {
        if (memory.speech.ttsIsPaused) return;  // user paused — not an error
        console.error("Speech synthesis error:", err);
        _resetTTSPlaybackState(element, memory);
    };

    memory.speech.currentUtterance = utterance;
    _setTTSButtonState(element, "speaking");
    window.speechSynthesis.speak(utterance);
}

/** Pauses the current utterance by cancelling and saving the char position. */
function _pauseTTS(memory, element) {
    memory.speech.ttsIsPaused = true;
    window.speechSynthesis.cancel();
    _setTTSButtonState(element, "paused");
}

/** Resumes TTS from the saved char position. */
function _resumeTTS(memory, element) {
    memory.speech.ttsIsPaused = false;
    memory.speech.speakingButton = element;
    _startTTSFromOffset(memory.speech.ttsPausedAt ?? 0, element, memory);
}

/**
 * Main TTS entry point — cycles: idle → speaking → paused → speaking …
 * Called by the speaker button in each AI response.
 */
export async function playTTS(element) {
    const memory = _chat_box.getMemoryByContainedElement(element);

    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        alert("Text-to-speech is not supported in this browser.");
        return;
    }

    const state = element.dataset.ttsstate || "idle";
    if (state === "speaking") { _pauseTTS(memory, element); return; }
    if (state === "paused")   { _resumeTTS(memory, element); return; }

    // idle — start from the beginning of this response
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending || memory?.speech?.ttsIsPaused) {
        cancelCurrentTTS(memory);
    }

    const aiResponseElement = element.closest("span.airesponse");
    if (!aiResponseElement) return;
    const textToSpeak = _normalizeSpeechText(aiResponseElement.innerText || aiResponseElement.textContent || "");
    if (!textToSpeak) return;

    memory.speech.ttsText = textToSpeak;
    memory.speech.speakingButton = element;
    _startTTSFromOffset(0, element, memory);
}

/**
 * Stops TTS entirely and resets the button to idle.
 * Called by the stop button in each AI response.
 */
export function stopTTS(element) {
    cancelCurrentTTS(_chat_box.getMemoryByContainedElement(element));
}
