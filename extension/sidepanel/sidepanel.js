const STATUS_LABEL = { idle: "대기 전", pending: "대기 전", running: "진행 중", done: "완료됨" };

const els = {
  runBadge: document.getElementById("run-badge"),
  runLabel: document.getElementById("run-label"),
  runToggleInput: document.getElementById("run-toggle-input"),
  runToggleLabel: document.getElementById("run-toggle-label"),
  openSiteBtn: document.getElementById("open-site-btn"),
  logList: document.getElementById("log-list"),
  slots: [0, 1].map((i) => ({
    section: document.getElementById(`slot-${i}`),
    statusBadge: document.querySelector(`[data-status-for="${i}"]`),
    enabled: document.querySelector(`#slot-${i} [data-field="enabled"]`),
    enabledLabel: document.querySelector(`#slot-${i} [data-field="enabled-label"]`),
    date: document.querySelector(`#slot-${i} [data-field="date"]`),
    queryBtn: document.querySelector(`#slot-${i} [data-field="query-btn"]`),
    stationsHint: document.querySelector(`#slot-${i} [data-field="stations-hint"]`),
    from: document.querySelector(`#slot-${i} [data-field="from"]`),
    to: document.querySelector(`#slot-${i} [data-field="to"]`),
    ampm: document.querySelectorAll(`#slot-${i} input[name="ampm-${i}"]`),
  })),
};

const DEFAULT_SLOT = () => ({
  enabled: true,
  date: "",
  from: "",
  to: "",
  ampm: "AM",
  status: "idle",
  stationsFrom: [],
  stationsTo: [],
  stationsError: null,
});
const DEFAULT_STATE = () => ({
  running: false,
  fetchingStations: false,
  fetchSlotIndex: null,
  slots: [DEFAULT_SLOT(), { ...DEFAULT_SLOT(), enabled: false }],
  logs: [],
  currentSlotIndex: -1,
  tabId: null,
});

init();

async function init() {
  const state = await getState();
  render(state);
  wireEvents();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.state) render(changes.state.newValue);
  });
}

async function getState() {
  const { state } = await chrome.storage.session.get("state");
  return state ?? DEFAULT_STATE();
}

async function patchState(patch) {
  const state = await getState();
  const next = { ...state, ...patch };
  await chrome.storage.session.set({ state: next });
  return next;
}

function wireEvents() {
  els.runToggleInput.addEventListener("change", onRunToggle);
  els.openSiteBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.dtis.mil.kr/m/" });
  });

  // <input type="date">는 같은 날짜를 다시 골라도 "change"가 안 뜬다(값이 그대로라서).
  // 그래서 change로 조회를 못 트리거했을 때를 대비해, 포커스를 벗어날 때(blur) 값이
  // 그대로여도 한 번 더 확인해 조회를 트리거한다.
  els.slots.forEach((slotEls, i) => {
    let changedSinceFocus = false;
    slotEls.enabled.addEventListener("change", () => updateSlotField(i, "enabled", slotEls.enabled.checked));
    slotEls.date.addEventListener("focus", () => {
      changedSinceFocus = false;
    });
    slotEls.date.addEventListener("change", async () => {
      changedSinceFocus = true;
      const date = slotEls.date.value;
      await updateSlotField(i, "date", date);
      if (date) onDateChanged(i, date);
    });
    slotEls.date.addEventListener("blur", () => {
      if (!changedSinceFocus && slotEls.date.value) onDateChanged(i, slotEls.date.value);
    });
    // 자동 조회가 가끔 안 눌릴 때를 위한 수동 조회 버튼.
    slotEls.queryBtn.addEventListener("click", () => {
      if (slotEls.date.value) onDateChanged(i, slotEls.date.value);
      slotEls.queryBtn.classList.add("flash");
      setTimeout(() => slotEls.queryBtn.classList.remove("flash"), 500);
    });
    slotEls.from.addEventListener("change", () => updateSlotField(i, "from", slotEls.from.value));
    slotEls.to.addEventListener("change", () => updateSlotField(i, "to", slotEls.to.value));
    slotEls.ampm.forEach((radio) =>
      radio.addEventListener("change", () => {
        if (radio.checked) updateSlotField(i, "ampm", radio.value);
      })
    );
  });
}

async function updateSlotField(index, field, value) {
  const state = await getState();
  const slots = state.slots.map((s, i) => (i === index ? { ...s, [field]: value } : s));
  await patchState({ slots });
}

async function onDateChanged(index, date) {
  const slotEls = els.slots[index];
  slotEls.stationsHint.textContent = "역 목록을 불러오는 중... (사이트 화면이 자동으로 이동합니다)";
  const result = await chrome.runtime.sendMessage({ type: "START_FETCH_STATIONS", date, slotIndex: index });
  if (result?.error) {
    slotEls.stationsHint.textContent = result.error;
  }
  // 완료/실패 결과는 background가 state를 갱신하면 storage.onChanged → render()로 반영됨.
}

// 시작/중지가 하나의 토글로 합쳐져 있다 — 체크(켜짐)=시작, 해제(꺼짐)=중지.
async function onRunToggle() {
  if (els.runToggleInput.checked) {
    const result = await onStart();
    if (result?.error) els.runToggleInput.checked = false; // 시작 실패 — 원래 상태로 되돌림
  } else {
    await onStop();
  }
}

async function onStart() {
  const state = await getState();
  const validSlots = state.slots.filter((s) => s.enabled && s.date && s.from && s.to);
  if (validSlots.length === 0) {
    const error = "체크된 신청 중 날짜/출발역/도착역이 모두 입력된 것이 없습니다.";
    els.slots[0].stationsHint.textContent = error;
    return { error };
  }
  const result = await chrome.runtime.sendMessage({ type: "START", slots: validSlots });
  if (result?.error) {
    els.slots[0].stationsHint.textContent = result.error;
  }
  return result;
}

async function onStop() {
  await chrome.runtime.sendMessage({ type: "STOP" });
}

function render(state) {
  if (!state) state = DEFAULT_STATE();

  els.runBadge.classList.toggle("running", state.running);
  els.runLabel.textContent = state.running ? "실행 중" : "대기 중";
  els.runToggleInput.checked = state.running;
  els.runToggleInput.disabled = state.fetchingStations;
  els.runToggleLabel.textContent = state.running ? "중지" : "시작";

  state.slots.forEach((slot, i) => {
    const slotEls = els.slots[i];
    if (!slotEls) return;

    slotEls.statusBadge.textContent = STATUS_LABEL[slot.status] ?? STATUS_LABEL.idle;
    slotEls.statusBadge.className = `status-badge ${slot.status === "running" ? "running" : ""} ${slot.status === "done" ? "done" : ""}`.trim();

    slotEls.enabled.checked = slot.enabled !== false;
    slotEls.enabledLabel.textContent = slotEls.enabled.checked ? "ON" : "OFF";
    slotEls.enabled.disabled = state.running;

    populateSelect(slotEls.from, slot.stationsFrom, slot.from);
    populateSelect(slotEls.to, slot.stationsTo, slot.to);

    const isFetchingThisSlot = state.fetchingStations && state.fetchSlotIndex === i;
    if (!isFetchingThisSlot) {
      slotEls.stationsHint.textContent = slot.stationsError
        ? slot.stationsError
        : slot.stationsFrom?.length
        ? `역 목록 ${slot.stationsFrom.length}개 불러옴`
        : "날짜를 선택하면 자동으로 역 목록을 불러옵니다";
    }

    if (document.activeElement !== slotEls.date) slotEls.date.value = slot.date;
    slotEls.ampm.forEach((radio) => (radio.checked = radio.value === slot.ampm));

    // 날짜는 역 목록을 읽어오는 중에도 바꿀 수 있어야 다시 조회를 트리거할 수 있다.
    slotEls.date.disabled = state.running;
    slotEls.queryBtn.disabled = state.running;
    [slotEls.from, slotEls.to, ...slotEls.ampm].forEach((el) => (el.disabled = state.running || state.fetchingStations));
  });

  renderLogs(state.logs);
}

function populateSelect(select, options, selectedValue) {
  const current = Array.from(select.options).map((o) => o.value);
  const next = options ?? [];
  if (current.join("|") !== next.join("|")) {
    select.innerHTML = next.map((st) => `<option value="${st}">${st}</option>`).join("");
  }
  if (selectedValue) select.value = selectedValue;
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    els.logList.innerHTML = `<div class="log-empty">아직 기록이 없습니다</div>`;
    return;
  }
  els.logList.innerHTML = logs
    .slice()
    .reverse()
    .map((entry) => `<div class="log-entry"><span class="log-time">${entry.time}</span><span>${entry.text}</span></div>`)
    .join("");
}
