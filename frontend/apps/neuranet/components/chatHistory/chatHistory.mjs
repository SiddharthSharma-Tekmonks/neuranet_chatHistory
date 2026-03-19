/**
 * @module chat-history-sidebar
 * Adds per-row "..." menu with rename (40-char) + delete via updateChatArchive API.
 */

import {util} from "/framework/js/util.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {monkshu_component} from "/framework/js/monkshu_component.mjs";

const COMPONENT_PATH = util.getModulePathFromURL(import.meta.url);

/* ===== Helpers from earlier code ===== */
function _normalizeHistoryResult(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  const candidates = ["files", "list", "history", "data", "items", "timestamps"];
  for (const key of candidates) if (Array.isArray(result[key])) return result[key];
  for (const k in result) if (result?.[k] && Array.isArray(result[k])) return result[k];
  return [];
}
function _normalizeHistoryItems(item) {
  if (typeof item === "string") return { chat_filename: item, title: "" };
  const chat_filename = item.chat_filename || item.file || item.name || item.path || "";
  const title = item.title || item.label || item.displayName || "";
  const ts = item.ts || item.timestamp || item.time || item.modified || item.created || "";
  const snippet = item.snippet || item.preview || "";
  return { chat_filename, title, ts, snippet };
}
function formatTimeStamp(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts.toString();
    return new Intl.DateTimeFormat(undefined, {month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit"}).format(d);
  } catch { return ts.toString(); }
}
function _titleFromFilename(chat_filename, fallbackTSHuman) {
  if (!chat_filename) return fallbackTSHuman ? `Chat — ${fallbackTSHuman}` : "Chat";
  const base = chat_filename.split(/[\\/]/).pop();
  const noext = base?.replace(/\.(ndjson|json|log|txt)$/i, "") || base;
  return noext || (fallbackTSHuman ? `Chat — ${fallbackTSHuman}` : "Chat");
}
function _mapChats(historyItems) {
  return historyItems
    .map(_normalizeHistoryItems)
    .filter(x => x.chat_filename)
    .map(x => {
      const ts_human = formatTimeStamp(x.ts);
      const displayTitle = x.title && String(x.title).trim() ? String(x.title).trim() : _titleFromFilename(x.chat_filename, ts_human);
      return { title: displayTitle, file: x.chat_filename, ts: x.ts || "", ts_human, snippet: x.snippet || "", active: false };
    })
    .sort((a,b)=> (b.ts||"") > (a.ts||"") ? 1 : ((b.ts||"") < (a.ts||"") ? -1 : 0));
}

/* Shared session auth fields */
const _getSessionAuth = () => ({ id: session.get(APP_CONSTANTS.USERID), org: session.get(APP_CONSTANTS.USERORG) });

/* ----- Globals for edit modal ----- */
const state = {
  menuOpenFor: null,       // element of .menu currently open
  editTarget: null         // { filename, currentTitle }
};

/* ----- Bind open handler (compat) ----- */
function bindChatHistoryHandler() {
  window.__openChat = async (file, ts) => {
    try {
      const list = document.getElementById("chatlist");
      if (list) {
        [...list.querySelectorAll(".chat-item")].forEach(el => {
          const same = (el.dataset.file === String(file)) && (el.dataset.ts === String(ts || ""));
          el.classList.toggle("active", same);
        });
      }
      if (window.matchMedia && matchMedia("(max-width: 900px)").matches) {
        document.body.classList.remove("sb-open");
      }

      const payload = { service: "readAll", chat_filename: String(file || "").trim(), ..._getSessionAuth() };
      const result = await apiman.rest(`${APP_CONSTANTS.API_PATH}/chatArchiveReader`, "POST", payload, true);

      if (result?.result && Array.isArray(result.objects)) {
        const ai_app   = result.objects[0]?.ai_app;
        const chat_filename = result.objects[0]?.chat_filename;
        const chatsession_id = result.objects[0]?.chatsession_id;

        session.set(APP_CONSTANTS.CHAT_HISTORY_CONVERSATION, result.objects);
        session.set(APP_CONSTANTS.FORCE_LOAD_VIEW, ai_app);
        session.set(APP_CONSTANTS.CHAT_FILENAME, chat_filename);
        session.set(APP_CONSTANTS.CHAT_SESSION_ID, chatsession_id);

        const {loginmanager} = await import (`${APP_CONSTANTS.LIB_PATH}/loginmanager.mjs`);
        loginmanager.addLogoutListener(`${COMPONENT_PATH}/../neuranetapp.mjs`, "neuranetapp", "onlogout");

        router.navigate(APP_CONSTANTS.MAIN_HTML);
      } else {
        console.warn("readAll failed or unexpected response:", { payload, result });
      }
    } catch (err) {
      console.error("chatArchiveReader/readAll error:", err);
    }
  };
}

/* ----- Fetch & render list ----- */
async function _fetchSidebarChats() {
  const { id, org } = _getSessionAuth();
  const ai_app = session.get(APP_CONSTANTS.FORCE_LOAD_VIEW);
  const orgid = `_${org}_${id}`;
  const filenamePattern = orgid.replace(/@/g, "_").replace(/\s+/g, "_");

  const req = { service: "listTimestamps", pattern: filenamePattern, caseInsensitive: false, ai_app, ..._getSessionAuth() };
  const res = await apiman.rest(`${APP_CONSTANTS.API_PATH}/chatArchiveReader`, "POST", req, true);
  const normalized = _normalizeHistoryResult(res);
  return _mapChats(normalized);
}

function _renderSidebarChats(chats) {
  const list = document.getElementById("chatlist");
  if (!list) return;

  const activeEl  = list.querySelector(".chat-item.active");
  const activeKey = activeEl ? (activeEl.dataset.file + "@" + (activeEl.dataset.ts||"")) : null;

  list.innerHTML = (chats && chats.length)
    ? chats.map(c => `
        <div class="chat-item ${c.active?"active":""}" data-file="${c.file}" data-ts="${c.ts||""}">
          <div class="text" data-action="open">
            <div class="title">${escapeHTML(c.title)}</div>
            <div class="meta">${c.ts_human || ""}${c.snippet ? (" • " + escapeHTML(c.snippet)) : ""}</div>
          </div>
          <button class="more-btn" title="More" aria-haspopup="menu" aria-expanded="false" data-action="menu">⋯</button>
          <div class="menu" role="menu">
            <button role="menuitem" data-action="rename">Rename</button>
            <button role="menuitem" data-action="delete">Delete</button>
          </div>
        </div>
      `).join("")
    : `<div class="chat-item" style="opacity:.7; cursor:default; color:#4FB4ED;">No chats yet</div>`;

  // restore active highlight
  if (activeKey) {
    const [f,t] = activeKey.split("@");
    const el = list.querySelector(`.chat-item[data-file="${CSS.escape(f)}"][data-ts="${CSS.escape(t)}"]`);
    if (el) el.classList.add("active");
  }
}

async function refreshSidebarChats() {
  try {
    const chats = await _fetchSidebarChats();
    window.__CHAT_HISTORY__ = chats;
    _renderSidebarChats(chats);
    bindChatHistoryHandler();
  } catch (e) {
    console.warn("Sidebar refresh failed:", e);
  }
}
window.__refreshSidebar = refreshSidebarChats;

/* ===== Utilities ===== */
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* Shared helper for updateChatArchive calls */
async function _callUpdateArchive(service, extra = {}) {
  const body = { service, ai_app: session.get(APP_CONSTANTS.FORCE_LOAD_VIEW), ..._getSessionAuth(), ...extra };
  return apiman.rest(`${APP_CONSTANTS.API_PATH}/updateChatArchive`, "POST", body, true);
}

/* ===== Element lifecycle ===== */
async function elementConnected(host) {
  document.body.setAttribute("data-sb-enabled", "1");
}
async function elementRendered(host) {
  const $ = (s, r=document)=>r.querySelector(s);
  const backdrop = $("#sb-backdrop");
  const collapse = $("#sb-collapse");
  const handle   = $("#sb-handle");
  const btnNew   = $("#sb-new");
  const chatlist = $("#chatlist");

  // modal bits
  const modalWrap = $("#ch-modal-backdrop");
  const modal     = $("#ch-modal");
  const titleInput= $("#ch-title-input");
  const saveBtn   = $("#ch-save");
  const cancelBtn = $("#ch-cancel");
  const closeX    = $("#ch-close");
  const delBtn    = $("#ch-delete");
  const countTxt  = $("#ch-count");
//   const fnTxt     = $("#ch-filename");

  const toggleSidebar = (force) => {
    const open = (typeof force === "boolean") ? force : !document.body.classList.contains("sb-open");
    document.body.classList.toggle("sb-open", open);
  };
  window.__toggleSidebar = () => toggleSidebar();

  backdrop?.addEventListener("click", ()=> toggleSidebar(false));
  collapse?.addEventListener("click", ()=> toggleSidebar(false));
  handle?.addEventListener("click", ()=> toggleSidebar());

  btnNew?.addEventListener("click", ()=> {
    const app = window?.monkshu_env?.apps?.[window.APP_CONSTANTS?.APP_NAME];
    app?.neuranetapp?.openView?.();
  });

  // List click delegation
  chatlist?.addEventListener("click", (e)=>{
    const row = e.target.closest(".chat-item");
    if (!row) return;

    const action = e.target?.dataset?.action || (e.target.closest("[data-action]")?.dataset?.action);
    const chat_filename = row.dataset.file;
    const ts = row.dataset.ts || "";

    // Open chat (click on text area)
    if (action === "open") {
      if (typeof window.__openChat === "function") window.__openChat(chat_filename, ts);
      return;
    }

    // Open menu
    if (action === "menu") {
      e.stopPropagation();
      _toggleRowMenu(row, true);
      return;
    }

    // Menu items
    const menuBtn = e.target.closest('[role="menuitem"]');
    if (menuBtn) {
      e.stopPropagation();
      if (menuBtn.dataset.action === "rename") {
        _toggleRowMenu(row, false);
        _openRenameModal({ chat_filename, currentTitle: row.querySelector(".title")?.textContent || "" });
      } else if (menuBtn.dataset.action === "delete") {
        _toggleRowMenu(row, false);
        _confirmDelete(chat_filename);
      }
      return;
    }
  });

  // Hide menus if clicking elsewhere
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".chat-item")) _toggleRowMenu(null, false);
  });

  // Modal behavior
  const closeModal = () => {
    modalWrap.classList.remove("open");
    modalWrap.setAttribute("aria-hidden", "true");
    state.editTarget = null;
    titleInput.value = "";
    // fnTxt.textContent = "";
    countTxt.textContent = "0 / 40";
    saveBtn.disabled = true;
  };
  closeX?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);
  modalWrap?.addEventListener("click", (e)=> {
    if (e.target === modalWrap) closeModal();
  });

  titleInput?.addEventListener("input", ()=>{
    const val = titleInput.value ?? "";
    countTxt.textContent = `${val.length} / 40`;
    saveBtn.disabled = !val.trim().length;
  });
  titleInput?.addEventListener("keydown", (e)=>{
    if (e.key === "Enter" && !saveBtn.disabled) {
      _saveRename().catch(console.error);
    }
  });
  saveBtn?.addEventListener("click", ()=> _saveRename().catch(console.error));

  delBtn?.addEventListener("click", ()=> {
    if (state.editTarget?.chat_filename) _confirmDelete(state.editTarget.chat_filename);
  });

  // initial list
  await refreshSidebarChats();

  /* ---- helpers bound to elementRendered scope ---- */
  function _toggleRowMenu(row, open) {
    // Close any open menu first
    if (state.menuOpenFor) {
      state.menuOpenFor.classList.remove("open");
      const btn = state.menuOpenFor.parentElement?.querySelector(".more-btn");
      if (btn) btn.setAttribute("aria-expanded", "false");
      state.menuOpenFor = null;
    }
    if (!row || open === false) return;
    const menu = row.querySelector(".menu");
    if (menu) {
      menu.classList.add("open");
      state.menuOpenFor = menu;
      const btn = row.querySelector(".more-btn");
      if (btn) btn.setAttribute("aria-expanded", "true");
    }
  }

  function _openRenameModal({ chat_filename, currentTitle }) {
    state.editTarget = { chat_filename, currentTitle };
    // fnTxt.textContent = filename;
    titleInput.value = (currentTitle || "").slice(0, 40);
    countTxt.textContent = `${titleInput.value.length} / 40`;
    saveBtn.disabled = !titleInput.value.trim().length;

    modalWrap.classList.add("open");
    modalWrap.setAttribute("aria-hidden", "false");
    setTimeout(()=> titleInput.focus(), 0);
  }

  async function _saveRename() {
    const chat_filename = state.editTarget?.chat_filename;
    const newTitle = String(titleInput.value || "").trim().slice(0, 40);
    if (!chat_filename || !newTitle) return;

    const res = await _callUpdateArchive("updateTitle", { chat_filename, title: newTitle });
    if (!res?.result) {
      alert("Failed to update title");
      return;
    }
    closeModal();
    await refreshSidebarChats();
  }

  async function _confirmDelete(chat_filename) {
    let current_chat = session.get(APP_CONSTANTS.CHAT_FILENAME).native.replace(/@/g, "_");
    const res = await _callUpdateArchive("delete", { chat_filename });
    if (!res?.result) {
      alert("Failed to delete chat");
      return;
    }
    // If you deleted the currently open chat, consider navigating home or clearing preload
    if (current_chat == chat_filename) {
      session.remove(APP_CONSTANTS.CHAT_HISTORY_CONVERSATION);
      session.remove(APP_CONSTANTS.CHAT_FILENAME);
      session.remove(APP_CONSTANTS.CHAT_SESSION_ID);
      let app = window?.monkshu_env?.apps?.[window.APP_CONSTANTS?.APP_NAME];
      app?.neuranetapp?.openView?.();
    }
    closeModal();
    await refreshSidebarChats();
  }
}

export const chat_history = { trueWebComponentMode: false, elementConnected, elementRendered, _normalizeHistoryResult, _mapChats, bindChatHistoryHandler, refreshSidebarChats};
monkshu_component.register("chat-history-sidebar", `${COMPONENT_PATH}/chatHistory.html`, chat_history);
