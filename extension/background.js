import { notifyAll } from "./lib/notify.js";

const SITE_ORIGIN = "https://www.dtis.mil.kr";
const MAX_LOGS = 50;

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "GET_STATE":
      return getState();
    case "START":
      return startAutomation(msg.slots);
    case "STOP":
      return stopAutomation("사용자가 중지를 눌렀습니다");
    case "FETCH_STATIONS":
      return fetchStations();
    case "GET_AUTOMATION_STATUS":
      return getAutomationStatus();
    case "LOG":
      return addLog(msg.text);
    case "NO_MATCH":
      await addLog(`슬롯 ${msg.slotIndex + 1}: 조건에 맞는 열차 없음 — 자동화를 멈춥니다`);
      return stopAutomation(`슬롯 ${msg.slotIndex + 1}에 맞는 열차를 찾지 못했습니다`);
    case "SLOT_DONE":
      return handleSlotDone(msg.slotIndex);
    default:
      return null;
  }
}

// ---------- State ----------

const DEFAULT_STATE = { running: false, slots: [], currentSlotIndex: -1, logs: [], tabId: null };

async function getState() {
  const { state } = await chrome.storage.session.get("state");
  return state ?? DEFAULT_STATE;
}

async function setState(patch) {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state });
  return state;
}

async function addLog(text) {
  const state = await getState();
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const logs = [...state.logs, { time, text }].slice(-MAX_LOGS);
  await setState({ logs });
}

// ---------- Automation control ----------

async function startAutomation(rawSlots) {
  const tabs = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` });
  const tab = tabs[0];
  if (!tab) {
    return { error: "사이트 페이지가 열려 있지 않습니다. 먼저 dtis.mil.kr 페이지를 열어주세요." };
  }

  const slots = rawSlots.map((s, index) => ({ ...s, index, status: "pending" }));
  slots[0].status = "running";

  await setState({ running: true, slots, currentSlotIndex: 0, logs: [], tabId: tab.id });

  await chrome.power.requestKeepAwake("system");
  watchTab(tab.id);
  await addLog(`자동화 시작 — 슬롯 ${slots.length}개`);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "AUTOMATION_STARTED" });
  } catch {
    // Content script not ready yet (e.g. tab was mid-navigation); it will
    // pick up the running state on its own via checkAndAct() on next load.
  }

  return { ok: true };
}

async function stopAutomation(reason) {
  const state = await getState();
  if (!state.running) return { ok: true };

  unwatchTab();
  await chrome.power.releaseKeepAwake();
  await setState({ running: false });
  await addLog(`자동화 중단: ${reason}`);
  await notifyAll(`⏹️ 자동화가 중단되었습니다: ${reason}`);
  return { ok: true };
}

async function getAutomationStatus() {
  const state = await getState();
  if (!state.running) return { running: false };
  const currentSlot = state.slots[state.currentSlotIndex];
  return { running: true, currentSlot };
}

async function handleSlotDone(slotIndex) {
  const state = await getState();
  const slots = state.slots.map((s, i) => (i === slotIndex ? { ...s, status: "done" } : s));
  await setState({ slots });

  const slot = slots[slotIndex];
  await notifyAll(
    `✅ 좌석 신청 완료: ${slot.date} ${slot.from} → ${slot.to} (${slot.ampm === "AM" ? "오전" : "오후"})`
  );

  const nextIndex = slotIndex + 1;
  if (nextIndex >= slots.length) {
    unwatchTab();
    await chrome.power.releaseKeepAwake();
    await setState({ running: false });
    await addLog("모든 슬롯 신청 완료 — 자동화 종료");
    return { ok: true };
  }

  const nextSlots = slots.map((s, i) => (i === nextIndex ? { ...s, status: "running" } : s));
  await setState({ slots: nextSlots, currentSlotIndex: nextIndex });
  await addLog(`슬롯 ${nextIndex + 1}로 이동 중`);

  await goBackTwice(state.tabId);
  // The page navigation above causes automate.js to re-inject and call
  // checkAndAct() on its own, so no explicit "start" message is needed here.
  return { ok: true };
}

async function fetchStations() {
  const tabs = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` });
  const tab = tabs[0];
  if (!tab) {
    return { error: "사이트 페이지가 열려 있지 않습니다. 먼저 dtis.mil.kr 페이지를 열어주세요." };
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_STATIONS" });
    if (!result) return { error: "역 목록을 읽어올 수 없습니다. 예약 화면(승차역/하차역 선택 화면)에서 다시 시도해주세요." };
    return result;
  } catch {
    return { error: "사이트 페이지와 통신할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요." };
  }
}

// ---------- Tab watching (F10: 탭 이탈 감지) ----------

function watchTab(tabId) {
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
}

function unwatchTab() {
  chrome.tabs.onRemoved.removeListener(onTabRemoved);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
}

async function onTabRemoved(tabId) {
  const state = await getState();
  if (state.running && tabId === state.tabId) {
    await stopAutomation("대상 탭이 닫혔습니다");
  }
}

async function onTabUpdated(tabId, changeInfo) {
  const state = await getState();
  if (!state.running || tabId !== state.tabId || !changeInfo.url) return;
  if (!changeInfo.url.startsWith(SITE_ORIGIN)) {
    await stopAutomation("대상 탭이 다른 페이지로 이동했습니다");
  }
}

// ---------- Back navigation (F8: 슬롯 전환) ----------

function goBackTwice(tabId) {
  return goBackAndWait(tabId).then(() => goBackAndWait(tabId));
}

function goBackAndWait(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.goBack(tabId);
  });
}
