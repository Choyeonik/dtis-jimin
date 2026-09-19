import { notifySuccess, notifyStop } from "./lib/notify.js";

const SITE_ORIGIN = "https://www.dtis.mil.kr";
const MAX_LOGS = 50;

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
      return stopEverything();
    case "START_FETCH_STATIONS":
      return startFetchStations(msg.date, msg.slotIndex);
    case "GET_FETCH_STATUS":
      return getFetchStatus();
    case "GET_RETURN_STATUS":
      return getReturnStatus();
    case "RETURN_DONE":
      return setState({ returningToScreenA: false }).then(() => ({ ok: true }));
    case "FETCH_STATIONS_RESULT":
      return finishFetchStations(msg.result, msg.token);
    case "FETCH_STATIONS_FAILED":
      return failFetchStations(msg.reason, msg.token);
    case "GET_AUTOMATION_STATUS":
      return getAutomationStatus();
    case "TRAIN_MATCHED":
      return setSlotTrainTime(msg.slotIndex, msg.departTime, msg.arriveTime);
    case "PICK_CANDIDATE":
      return pickCandidate(msg.slotIndex, msg.candidateIds);
    case "CANDIDATE_EXHAUSTED":
      return candidateExhausted(msg.slotIndex, msg.reason);
    case "SEAT_APPLY_STARTED":
      return setPendingTicket(msg.slotIndex, msg.ticket);
    case "SEAT_APPLY_FAILED":
      return setPendingTicket(msg.slotIndex, null);
    case "LOG":
      return addLog(msg.text);
    case "NO_MATCH":
      await addLog(`슬롯 ${msg.slotIndex + 1}: 조건에 맞는 열차 없음 — 자동화를 멈춥니다`);
      return stopAutomation(`슬롯 ${msg.slotIndex + 1}에 맞는 열차를 찾지 못했습니다`);
    case "DUPLICATE_BOOKING":
      await addLog(`슬롯 ${msg.slotIndex + 1}: 이미 예약된 구간으로 보여 자동화를 멈춥니다 (${msg.reason})`);
      return stopAutomation(`슬롯 ${msg.slotIndex + 1}: 중복된 구간 — ${msg.reason}`);
    case "SLOT_DONE":
      return handleSlotDone(msg.slotIndex, msg.ticket);
    default:
      return null;
  }
}

// ---------- State ----------

const DEFAULT_STATE = {
  running: false,
  slots: [],
  currentSlotIndex: -1,
  logs: [],
  tabId: null,
  fetchingStations: false,
  fetchDate: null,
  fetchSlotIndex: null,
  fetchToken: 0,
  returningToScreenA: false,
};

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

// 실패(또는 설정 누락)를 실행 로그에 남겨서, 조용히 안 오는 알림의 원인을
// "config.js 확인해야 함" 수준까지는 바로 알 수 있게 한다.
async function logNotifyResults(results) {
  for (const r of results) {
    if (!r.ok) await addLog(`${r.channel} 알림 실패: ${r.detail}`);
  }
}

// ---------- Automation control ----------

async function startAutomation(rawSlots) {
  const existing = await getState();
  if (existing.fetchingStations) {
    return { error: "역 목록을 읽어오는 중입니다. 잠시 후 다시 시도해주세요." };
  }

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
  await logNotifyResults(await notifyStop(`${formatTimestamp()} ⏹️ 자동화가 중단되었습니다: ${reason}`));
  return { ok: true };
}

// "중지" 버튼은 자동화뿐 아니라, 통신 실패 등으로 멈춰버린 역 목록 읽기 상태도
// 함께 풀어준다 — 그게 없으면 한 번 걸리면 사용자가 되돌릴 방법이 없었다.
async function stopEverything() {
  const state = await getState();
  if (state.running) await stopAutomation("사용자가 중지를 눌렀습니다");
  if (state.fetchingStations) await failFetchStations("사용자가 중지를 눌렀습니다", state.fetchToken);
  return { ok: true };
}

async function getAutomationStatus() {
  const state = await getState();
  if (!state.running) return { running: false };
  const currentSlot = state.slots[state.currentSlotIndex];
  return { running: true, currentSlot };
}

// 화면A의 조회 결과 행("역명 10:00")에서 붙잡은 출발/도착 시간을 슬롯에 남겨둔다 —
// 화면C의 잔여석 표에는 시간이 없는 경우가 많아, 완료 알림에는 이 값을 쓴다.
async function setSlotTrainTime(slotIndex, departTime, arriveTime) {
  const state = await getState();
  const slots = state.slots.map((s, i) => (i === slotIndex ? { ...s, departTime, arriveTime } : s));
  await setState({ slots });
  return { ok: true };
}

// 라운드로빈 (F3 확장): 조건에 맞는 열차가 여러 대면 한 대에만 매달리지 않고
// 돌아가며 확인한다. "다음엔 뭘 시도할지"는 여기(background)가 정한다 — 직전에
// 시도했던 열차 id를 기억해뒀다가, 이번에 돌아온 후보 목록에서 그다음 것을 고른다.
// (그 열차가 이번엔 후보에서 빠졌으면(매진 등) 처음부터 다시 시작.)
async function pickCandidate(slotIndex, candidateIds) {
  const state = await getState();
  const lastId = state.slots[slotIndex]?.lastTriedCandidateId;
  let nextId = candidateIds[0];
  if (lastId != null) {
    const pos = candidateIds.indexOf(lastId);
    if (pos !== -1) nextId = candidateIds[(pos + 1) % candidateIds.length];
  }
  // 후보가 1개뿐이면 화면C가 라운드로빈 대신 그 열차에서 계속 새로고침하도록,
  // 몇 개 중에서 골랐는지도 같이 남겨둔다.
  const slots = state.slots.map((s, i) =>
    i === slotIndex ? { ...s, lastTriedCandidateId: nextId, candidateCount: candidateIds.length } : s
  );
  await setState({ slots });
  return { id: nextId };
}

// 이번에 고른 열차에서 좌석을 못 잡았을 때(빈자리 없음 / 신청했다가 놓침) — 화면A로
// 돌아가는 것까지만 여기서 시작해두고, 다음 후보를 고르는 건 content script가
// 화면A에 다시 도착했을 때 runScreenA() → pickCandidate()가 이어서 한다.
async function candidateExhausted(slotIndex, reason) {
  const state = await getState();
  await addLog(`슬롯 ${slotIndex + 1}: ${reason || "이번 열차엔 좌석 없음"} — 다음 후보로 이동`);
  await startReturnToScreenA(state.tabId);
  return { ok: true };
}

// 좌석신청 성공은 alert 없이 곧바로 화면이 넘어가버릴 수 있어(실패는 화면C에 그대로
// 남는다), 클릭 직전에 "이 티켓을 신청해뒀다"고 남겨두고, 화면C를 벗어난 채 다시
// 로드된 페이지가 이걸 보고 성공으로 확정 짓는다.
async function setPendingTicket(slotIndex, ticket) {
  const state = await getState();
  const slots = state.slots.map((s, i) => (i === slotIndex ? { ...s, pendingTicket: ticket } : s));
  await setState({ slots });
  return { ok: true };
}

function buildSuccessMessage(info) {
  return [
    "# :bell: 잔여석을 신청 완료했습니다. :bell:",
    "## DTIS에 접속하여 신청완료를 꼭 확인해주세요.",
    ":exclamation: 알림이 오류일 수 있습니다.",
    "",
    "---------------------------------------",
    `탑승일자 : ${info.date}`,
    `출발역 : ${info.from}`,
    `도착역 : ${info.to}`,
    `출발 시간 : ${info.departTime} ~ 도착시간 : ${info.arriveTime}`,
    "---------------------------------------",
  ].join("\n");
}

async function handleSlotDone(slotIndex, ticket) {
  const state = await getState();
  if (state.slots[slotIndex]?.status === "done") return { ok: true }; // 이미 처리됨(중복 신호) — 무시

  const slots = state.slots.map((s, i) => (i === slotIndex ? { ...s, status: "done", pendingTicket: null } : s));
  await setState({ slots });

  const slot = slots[slotIndex];
  const info = ticket || { date: slot.date, from: slot.from, to: slot.to, departTime: "-", arriveTime: "-" };
  await logNotifyResults(await notifySuccess(buildSuccessMessage(info)));

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

  await startReturnToScreenA(state.tabId);
  // 화면A 도착은 content script가 스스로 판단하고, 그 뒤엔 매 페이지 로드마다
  // checkAndAct()가 자동으로 다시 실행되므로 별도의 "start" 메시지가 필요 없다.
  return { ok: true };
}

// ---------- Station list (F1: 역 목록 읽어오기) ----------
// 날짜를 입력하고 "조회"만 누른 뒤, 그 결과 테이블에 실제로 나온 출발역/도착역만
// 읽어온다(예약가능/확인 등 실제 예약 절차에는 들어가지 않으므로 화면A를 벗어나지
// 않는다). automate.js의 checkFetchAndAct()가 조회를 수행하고
// FETCH_STATIONS_RESULT로 결과를 보내온다.
//
// 진행 중에 사용자가 날짜를 다시 바꾸면 fetchToken을 올려서 새 요청으로 취급한다.
// automate.js는 결과를 보낼 때 자신이 시작할 때 받은 token을 그대로 붙여 보내고,
// 그 token이 최신 fetchToken과 다르면(=날짜가 또 바뀌어 낡은 요청이 됨) 무시한다.

async function startFetchStations(date, slotIndex) {
  const state = await getState();
  if (state.running) {
    return { error: "자동화 실행 중에는 역 목록을 다시 읽어올 수 없습니다." };
  }

  const tabs = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` });
  const tab = tabs[0];
  if (!tab) {
    return { error: "사이트 페이지가 열려 있지 않습니다. 먼저 dtis.mil.kr 페이지를 열어주세요." };
  }

  const token = (state.fetchToken || 0) + 1;
  const slots = state.slots.map((s, i) => (i === slotIndex ? { ...s, stationsError: null } : s));
  await setState({
    fetchingStations: true,
    fetchDate: date || null,
    fetchSlotIndex: slotIndex,
    fetchToken: token,
    slots,
  });
  const delivered = await sendWithRetry(tab.id, { type: "FETCH_STATIONS_STARTED" });
  if (!delivered) {
    // 사이트가 마침 페이지 이동 중이라 콘텐츠 스크립트가 잠깐 없는 순간일 수 있어
    // 재시도했지만 그래도 실패함 — "불러오는 중..."에 영원히 멈춰있지 않도록 바로 실패 처리.
    await failFetchStations("사이트 페이지와 통신할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.", token);
    return { error: "사이트 페이지와 통신할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요." };
  }
  return { ok: true };
}

// 페이지가 느리게 로드되는 동안은 콘텐츠 스크립트가 아직 안 붙어있을 수 있으므로
// 충분히 기다렸다가 재시도한다(최대 약 6초).
async function sendWithRetry(tabId, message, attempts = 15, delayMs = 400) {
  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function getFetchStatus() {
  const state = await getState();
  if (!state.fetchingStations) return { fetching: false };
  return { fetching: true, date: state.fetchDate, token: state.fetchToken };
}

async function finishFetchStations(result, token) {
  const state = await getState();
  if (state.fetchToken !== token) return { ok: true }; // 날짜가 또 바뀌어 낡은 결과가 됨 — 무시

  const idx = state.fetchSlotIndex ?? 0;
  const empty = result.stationsFrom.length === 0 && result.stationsTo.length === 0;
  if (empty) {
    return failFetchStations("조회된 목록이 없습니다.", token);
  }

  const slots = state.slots.map((s, i) =>
    i === idx ? { ...s, stationsFrom: result.stationsFrom, stationsTo: result.stationsTo } : s
  );
  await setState({ fetchingStations: false, slots });
  await addLog(`슬롯 ${idx + 1}: 역 목록을 읽어왔습니다 (출발역 ${result.stationsFrom.length}개, 도착역 ${result.stationsTo.length}개)`);
  return { ok: true };
}

async function failFetchStations(reason, token) {
  const state = await getState();
  if (state.fetchToken !== token) return { ok: true }; // 낡은 요청의 실패 — 무시

  const idx = state.fetchSlotIndex ?? 0;
  const slots = state.slots.map((s, i) => (i === idx ? { ...s, stationsError: reason } : s));
  await setState({ fetchingStations: false, slots });
  await addLog(`슬롯 ${idx + 1}: 역 목록 읽어오기 실패: ${reason}`);
  return { ok: true };
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
// 브라우저의 실제 "뒤로가기"(chrome.tabs.goBack)는 사이트 화면의 "< 이전" 버튼과
// 다르게 동작해 히스토리를 사이트 첫 페이지까지 거슬러 올라가버리는 문제가 있었다.
// 그래서 대신 content script가 화면A에 도착할 때까지 실제 "이전" 버튼을 반복 클릭하게
// 하고, background는 returningToScreenA 플래그로 그 진행 상태만 들고 있는다.

async function startReturnToScreenA(tabId) {
  await setState({ returningToScreenA: true });
  await sendWithRetry(tabId, { type: "CONTINUE_RETURN" });
}

async function getReturnStatus() {
  const state = await getState();
  return { returning: !!state.returningToScreenA };
}
