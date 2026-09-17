const STATUS_LABEL = { idle: "대기 전", pending: "대기 전", running: "진행 중", done: "완료됨" };

const els = {
  runBadge: document.getElementById("run-badge"),
  runLabel: document.getElementById("run-label"),
  fetchBtn: document.getElementById("fetch-stations-btn"),
  fetchHint: document.getElementById("fetch-stations-hint"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  logList: document.getElementById("log-list"),
  slots: [0, 1].map((i) => ({
    section: document.getElementById(`slot-${i}`),
    statusBadge: document.querySelector(`[data-status-for="${i}"]`),
    date: document.querySelector(`#slot-${i} [data-field="date"]`),
    from: document.querySelector(`#slot-${i} [data-field="from"]`),
    to: document.querySelector(`#slot-${i} [data-field="to"]`),
    ampm: document.querySelectorAll(`#slot-${i} input[name="ampm-${i}"]`),
  })),
};

const DEFAULT_SLOT = () => ({ date: "", from: "", to: "", ampm: "AM", status: "idle" });
const DEFAULT_STATE = () => ({
  running: false,
  slots: [DEFAULT_SLOT(), DEFAULT_SLOT()],
  logs: [],
  stationsFrom: [],
  stationsTo: [],
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
  els.fetchBtn.addEventListener("click", onFetchStations);
  els.startBtn.addEventListener("click", onStart);
  els.stopBtn.addEventListener("click", onStop);

  els.slots.forEach((slotEls, i) => {
    slotEls.date.addEventListener("change", () => updateSlotField(i, "date", slotEls.date.value));
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

async function onFetchStations() {
  els.fetchBtn.disabled = true;
  els.fetchHint.textContent = "읽어오는 중...";
  const result = await chrome.runtime.sendMessage({ type: "FETCH_STATIONS" });
  els.fetchBtn.disabled = false;

  if (result?.error) {
    els.fetchHint.textContent = result.error;
    return;
  }
  await patchState({ stationsFrom: result.stationsFrom, stationsTo: result.stationsTo });
  els.fetchHint.textContent = `최근 갱신 ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`;
}

async function onStart() {
  const state = await getState();
  const validSlots = state.slots.filter((s) => s.date && s.from && s.to);
  if (validSlots.length === 0) {
    els.fetchHint.textContent = "슬롯에 날짜/출발역/도착역을 입력해주세요.";
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "START", slots: validSlots });
  if (result?.error) {
    els.fetchHint.textContent = result.error;
  }
}

async function onStop() {
  await chrome.runtime.sendMessage({ type: "STOP" });
}

function render(state) {
  if (!state) state = DEFAULT_STATE();

  els.runBadge.classList.toggle("running", state.running);
  els.runLabel.textContent = state.running ? "실행 중" : "대기 중";
  els.startBtn.disabled = state.running;
  els.stopBtn.disabled = !state.running;

  state.slots.forEach((slot, i) => {
    const slotEls = els.slots[i];
    if (!slotEls) return;

    slotEls.statusBadge.textContent = STATUS_LABEL[slot.status] ?? STATUS_LABEL.idle;
    slotEls.statusBadge.className = `status-badge ${slot.status === "running" ? "running" : ""} ${slot.status === "done" ? "done" : ""}`.trim();

    populateSelect(slotEls.from, state.stationsFrom, slot.from);
    populateSelect(slotEls.to, state.stationsTo, slot.to);

    if (document.activeElement !== slotEls.date) slotEls.date.value = slot.date;
    slotEls.ampm.forEach((radio) => (radio.checked = radio.value === slot.ampm));

    [slotEls.date, slotEls.from, slotEls.to, ...slotEls.ampm].forEach((el) => (el.disabled = state.running));
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
