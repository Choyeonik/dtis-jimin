const STATUS_LABEL = { idle: "대기 전", pending: "대기 전", running: "진행 중", done: "완료됨" };

const els = {
  runBadge: document.getElementById("run-badge"),
  runLabel: document.getElementById("run-label"),
  runToggleInput: document.getElementById("run-toggle-input"),
  runToggleLabel: document.getElementById("run-toggle-label"),
  openSiteBtn: document.getElementById("open-site-btn"),
  shutdownToggleInput: document.getElementById("shutdown-toggle-input"),
  shutdownToggleLabel: document.getElementById("shutdown-toggle-label"),
  shutdownBanner: document.getElementById("shutdown-banner"),
  shutdownCountdown: document.getElementById("shutdown-countdown"),
  shutdownCancelBtn: document.getElementById("shutdown-cancel-btn"),
  scheduleInput: document.getElementById("schedule-input"),
  scheduleToggleInput: document.getElementById("schedule-toggle-input"),
  scheduleToggleLabel: document.getElementById("schedule-toggle-label"),
  scheduleHint: document.getElementById("schedule-hint"),
  keepAliveHint: document.getElementById("keepalive-hint"),
  schedulePickerBtn: document.getElementById("schedule-picker-btn"),
  scheduleOn: document.getElementById("schedule-on"),
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
    altFrom: Array.from(document.querySelectorAll(`#slot-${i} [data-field="altFrom"]`)),
    altTo: Array.from(document.querySelectorAll(`#slot-${i} [data-field="altTo"]`)),
    ampm: document.querySelectorAll(`#slot-${i} input[name="ampm-${i}"]`),
  })),
};

const DEFAULT_SLOT = () => ({
  enabled: true,
  date: "",
  from: "",
  to: "",
  altFrom: ["", ""],
  altTo: ["", ""],
  ampm: "AM",
  status: "idle",
  stationsFrom: [],
  stationsTo: [],
  stationsError: null,
});
const DEFAULT_STATE = () => ({
  running: false,
  shutdownOnSuccess: false,
  fetchingStations: false,
  fetchSlotIndex: null,
  slots: [DEFAULT_SLOT(), { ...DEFAULT_SLOT(), enabled: false }],
  logs: [],
  currentSlotIndex: -1,
  tabId: null,
});

let shutdownAt = null;
let nextKeepAliveAt = null;
let scheduledStartAt = null;
let scheduleError = null;
let pickerOpen = false;

function setPickerOpen(open) {
  pickerOpen = open;
  els.schedulePickerBtn.textContent = open ? "확인" : "열기";
}

init();

async function init() {
  const state = await getState();
  render(state);
  wireEvents();
  setInterval(() => {
    renderShutdownCountdown();
    renderKeepAliveCountdown();
  }, 1000);
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
  els.shutdownToggleInput.addEventListener("change", () =>
    patchState({ shutdownOnSuccess: els.shutdownToggleInput.checked })
  );
  els.shutdownCancelBtn.addEventListener("click", async () => {
    els.shutdownCancelBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: "CANCEL_SHUTDOWN" }); // 결과는 실행 로그에 남는다
    els.shutdownCancelBtn.disabled = false;
  });
  els.scheduleToggleInput.addEventListener("change", onScheduleToggle);
  // 캘린더 아이콘을 숨기고 "열기/확인" 버튼 하나로 연다/닫는다. 닫는 건 Chrome이 팝업
  // 바깥을 누르면 알아서 닫아주는 걸 이용한다 — 버튼을 누르는 것 자체가 바깥 클릭이다.
  els.schedulePickerBtn.addEventListener("click", () => {
    if (pickerOpen) {
      els.scheduleInput.blur();
      setPickerOpen(false);
      return;
    }
    els.scheduleInput.focus();
    try {
      els.scheduleInput.showPicker();
      setPickerOpen(true);
    } catch {
      // 비활성 상태 등으로 열 수 없으면 그대로 둔다.
    }
  });
  // 버튼이 아닌 다른 곳을 눌러 캘린더가 닫힌 경우에도 버튼 글자를 "열기"로 되돌린다.
  // (버튼을 눌러 생긴 blur는 위 클릭 처리에 맡긴다 — 여기서 먼저 닫힘 처리하면 클릭이 다시 열어버림)
  els.scheduleInput.addEventListener("blur", (e) => {
    if (e.relatedTarget !== els.schedulePickerBtn) setPickerOpen(false);
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
    ["altFrom", "altTo"].forEach((field) =>
      slotEls[field].forEach((input) =>
        input.addEventListener("change", () => updateSlotField(i, field, slotEls[field].map((el) => el.value.trim())))
      )
    );
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

const NO_VALID_SLOT = "체크된 신청 중 날짜/출발역/도착역이 모두 입력된 것이 없습니다.";

// 역 목록을 불러오면 드롭다운에 첫 역이 보이기만 하고 값은 저장되지 않는다(change가 안 뜸).
// 그래서 시작(또는 예약)할 때 화면에 보이는 값을 그대로 저장해, 보이는 대로 실행되게 한다.
async function saveVisibleSlots() {
  const state = await getState();
  const slots = state.slots.map((s, i) => ({
    ...s,
    from: els.slots[i]?.from.value || s.from,
    to: els.slots[i]?.to.value || s.to,
  }));
  await patchState({ slots });
  return slots.filter((s) => s.enabled && s.date && s.from && s.to);
}

async function onStart() {
  const validSlots = await saveVisibleSlots();
  if (validSlots.length === 0) {
    els.slots[0].stationsHint.textContent = NO_VALID_SLOT;
    return { error: NO_VALID_SLOT };
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

// 예약 시작 — 켜면 background가 그 시각에 알람을 걸어두고, 시각이 되면 시작 버튼을
// 누른 것과 똑같이 실행한다(사이드패널이 닫혀 있어도 됨).
async function onScheduleToggle() {
  scheduleError = null;
  if (!els.scheduleToggleInput.checked) {
    await chrome.runtime.sendMessage({ type: "CANCEL_SCHEDULED_START" });
    return;
  }
  const at = els.scheduleInput.value ? new Date(els.scheduleInput.value).getTime() : NaN;
  let error = null;
  if (Number.isNaN(at)) error = "예약할 날짜와 시각을 먼저 입력해주세요.";
  else if (at <= Date.now()) error = "예약 시각이 이미 지났습니다.";
  else if ((await saveVisibleSlots()).length === 0) error = NO_VALID_SLOT;
  else error = (await chrome.runtime.sendMessage({ type: "SCHEDULE_START", at }))?.error ?? null;

  if (error) {
    scheduleError = error;
    els.scheduleToggleInput.checked = false;
    render(await getState());
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// <input type="datetime-local">은 시간대 없는 "YYYY-MM-DDTHH:MM"(로컬 시각) 형식이다.
function toLocalInputValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function render(state) {
  if (!state) state = DEFAULT_STATE();

  els.runBadge.classList.toggle("running", state.running);
  els.runLabel.textContent = state.running ? "실행 중" : "대기 중";
  els.runToggleInput.checked = state.running;
  // 예약해 둔 동안은 직접 시작하지 못하게 막는다 — 시작하려면 예약을 먼저 풀어야 한다.
  els.runToggleInput.disabled = state.fetchingStations || !!state.scheduledStartAt;
  els.runToggleLabel.textContent = state.running ? "중지" : "시작";
  els.shutdownToggleInput.checked = !!state.shutdownOnSuccess;
  els.shutdownToggleLabel.textContent = state.shutdownOnSuccess ? "ON" : "OFF";
  shutdownAt = state.shutdownAt ?? null;
  renderShutdownCountdown();

  const scheduledAt = state.scheduledStartAt ?? null;
  scheduledStartAt = scheduledAt;
  nextKeepAliveAt = state.nextKeepAliveAt ?? null;
  renderKeepAliveCountdown();
  els.scheduleToggleInput.checked = !!scheduledAt;
  els.scheduleToggleLabel.textContent = scheduledAt ? "예약 안함" : "예약 시작";
  els.scheduleToggleInput.disabled = state.running;
  els.scheduleInput.disabled = state.running || !!scheduledAt;
  els.schedulePickerBtn.disabled = els.scheduleInput.disabled;
  if (els.scheduleInput.disabled) setPickerOpen(false);
  els.scheduleOn.classList.toggle("active", !!scheduledAt);
  if (scheduledAt && document.activeElement !== els.scheduleInput) els.scheduleInput.value = toLocalInputValue(scheduledAt);
  if (scheduledAt) {
    const d = new Date(scheduledAt);
    els.scheduleHint.textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}에 자동으로 시작합니다`;
  } else {
    els.scheduleHint.textContent = scheduleError ?? "";
  }
  els.scheduleHint.hidden = !els.scheduleHint.textContent;

  // 예약해둔 동안 신청 내용이 바뀌면 예약한 것과 다르게 실행될 수 있어 실행 중처럼 잠근다.
  const locked = state.running || !!scheduledAt;

  state.slots.forEach((slot, i) => {
    const slotEls = els.slots[i];
    if (!slotEls) return;

    slotEls.statusBadge.textContent = STATUS_LABEL[slot.status] ?? STATUS_LABEL.idle;
    slotEls.statusBadge.className = `status-badge ${slot.status === "running" ? "running" : ""} ${slot.status === "done" ? "done" : ""}`.trim();

    slotEls.enabled.checked = slot.enabled !== false;
    slotEls.enabledLabel.textContent = slotEls.enabled.checked ? "ON" : "OFF";
    slotEls.enabled.disabled = locked;

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
    ["altFrom", "altTo"].forEach((field) =>
      slotEls[field].forEach((el, k) => {
        if (document.activeElement !== el) el.value = slot[field]?.[k] ?? "";
      })
    );
    slotEls.ampm.forEach((radio) => (radio.checked = radio.value === slot.ampm));

    // 날짜는 역 목록을 읽어오는 중에도 바꿀 수 있어야 다시 조회를 트리거할 수 있다.
    slotEls.date.disabled = locked;
    slotEls.queryBtn.disabled = locked;
    [slotEls.from, slotEls.to, ...slotEls.altFrom, ...slotEls.altTo, ...slotEls.ampm].forEach((el) => (el.disabled = locked || state.fetchingStations));
  });

  renderLogs(state.logs);
}

// 예약 시각 전에 다음 로그인 유지 요청이 있을 때만 보여준다(예약 시각이 더 빠르면 요청은 안 일어남).
function renderKeepAliveCountdown() {
  const remainMs = nextKeepAliveAt ? nextKeepAliveAt - Date.now() : 0;
  const show = remainMs > 0 && scheduledStartAt && nextKeepAliveAt < scheduledStartAt;
  els.keepAliveHint.hidden = !show;
  if (!show) return;
  const totalSec = Math.ceil(remainMs / 1000);
  els.keepAliveHint.textContent = `로그인 유지를 위한 새로고침 ${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`;
}

function renderShutdownCountdown() {
  const remainMs = shutdownAt ? shutdownAt - Date.now() : 0;
  els.shutdownBanner.hidden = remainMs <= 0;
  if (remainMs <= 0) return;
  const totalSec = Math.ceil(remainMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  els.shutdownCountdown.textContent = `${mm}:${ss}`;
}

// 역명은 사이트 조회 결과에서, 로그 문구는 사이트가 띄운 alert 메시지에서 오므로
// 둘 다 이 확장이 통제할 수 없는 텍스트다 — innerHTML 대신 textContent로 넣어서
// 사이트가 악성 HTML을 끼워 넣어도 태그로 해석되지 않게 한다.
function populateSelect(select, options, selectedValue) {
  const current = Array.from(select.options).map((o) => o.value);
  const next = options ?? [];
  if (current.join("|") !== next.join("|")) {
    select.innerHTML = "";
    next.forEach((st) => {
      const option = document.createElement("option");
      option.value = st;
      option.textContent = st;
      select.appendChild(option);
    });
  }
  if (selectedValue) select.value = selectedValue;
}

function renderLogs(logs) {
  els.logList.innerHTML = "";
  if (!logs || logs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "아직 기록이 없습니다";
    els.logList.appendChild(empty);
    return;
  }
  logs
    .slice()
    .reverse()
    .forEach((entry) => {
      const row = document.createElement("div");
      row.className = "log-entry";
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = entry.time;
      const text = document.createElement("span");
      text.textContent = entry.text;
      row.append(time, text);
      els.logList.appendChild(row);
    });
}
