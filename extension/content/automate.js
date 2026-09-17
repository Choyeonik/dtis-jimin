// Isolated-world content script for dtis.mil.kr (see manifest.json).
// Runs on every page load. Each load, it asks the background service worker
// whether automation is currently running and, if so, figures out which
// screen (A/B/C, see docs/04-features.md) it landed on and acts accordingly.
//
// NOTE ON SELECTORS: all of screen A/B/C's key elements below are confirmed
// against real site HTML. One quirk to remember: #fromDtTm exists on BOTH
// screen A (the editable `type="date"` input) and screen C (a disabled
// read-only display of the same id) — screens are told apart by checking
// the input's `type`, not just presence of the id.

(function () {
  const DIALOG_EVENT = "dtis-automation-dialog";

  let lastAlert = null; // { message, time }
  window.addEventListener(DIALOG_EVENT, (e) => {
    if (e.detail?.type === "alert") {
      lastAlert = { message: e.detail.message, time: Date.now() };
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "FETCH_STATIONS") {
      sendResponse(readStationOptions());
      return true;
    }
    if (msg.type === "AUTOMATION_STARTED") {
      checkAndAct();
    }
  });

  checkAndAct();

  async function checkAndAct() {
    const status = await sendToBackground({ type: "GET_AUTOMATION_STATUS" });
    if (!status?.running || !status.currentSlot) return;
    await handleCurrentScreen(status.currentSlot);
  }

  async function handleCurrentScreen(slot) {
    if (isScreenC()) return runScreenC(slot);
    if (isScreenB()) return runScreenB();
    if (isScreenA()) return runScreenA(slot);
    // Unknown screen — nothing to do; background will keep waiting.
  }

  // ---------- Screen detection ----------

  function isScreenA() {
    return findDateInput()?.type === "date";
  }

  function isScreenB() {
    return !!document.querySelector('button[onclick*="linkPage02"]');
  }

  function isScreenC() {
    return !!document.getElementById("sstation") && !!document.getElementById("estation");
  }

  // ---------- Screen A: 탑승신청 (날짜 조회 + 결과 테이블) ----------

  async function runScreenA(slot) {
    const dateInput = findDateInput();
    if (dateInput && dateInput.value !== slot.date) {
      setNativeValue(dateInput, slot.date);
      dateInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    findClickableByText("조회")?.click();

    // #m_table_02's rows are re-rendered by srch(); give it a moment to load.
    await waitFor(() => findResultRows().length > 0, 4000);

    const rows = findResultRows();
    const match = rows.find((row) => rowMatchesSlot(row, slot));
    if (!match) {
      await sendToBackground({ type: "NO_MATCH", slotIndex: slot.index });
      log(`슬롯 ${slot.index + 1}: 조건에 맞는 열차를 찾지 못함`);
      return;
    }

    log(`슬롯 ${slot.index + 1}: 조건에 맞는 열차 발견, 예약가능 클릭`);
    match.querySelector("button.m_btn_106")?.click();
    // linkPage01_01_2(id, date, 1) navigates to Screen B; script re-runs fresh on the new page.
  }

  function findResultRows() {
    return Array.from(document.querySelectorAll("#m_table_02 tr.m_table_html_tr"));
  }

  // Column order in #m_table_02: 번호(0) 신청여부(1) 잔여석(2) 일자(3) 열차명(4) 출발역(5) 도착역(6)
  function rowMatchesSlot(row, slot) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 7) return false;
    const fromText = cells[5].textContent;
    const toText = cells[6].textContent;
    if (!fromText.startsWith(slot.from) || !toText.startsWith(slot.to)) return false;

    const m = fromText.match(/(\d{1,2}):(\d{2})/);
    if (!m) return true; // can't verify AM/PM, don't block on it
    const isPM = parseInt(m[1], 10) >= 12;
    return slot.ampm === "PM" ? isPM : !isPM;
  }

  // ---------- Screen B: 안내 팝업 ----------

  async function runScreenB() {
    log("화면B: 안내 팝업 확인");
    document.querySelector('button[onclick*="linkPage02"]')?.click();
    // linkPage02() navigates to Screen C.
  }

  // ---------- Screen C: 잔여석예약 (새로고침 반복 + 좌석신청) ----------

  async function runScreenC(slot) {
    const fromSelect = document.getElementById("sstation");
    const toSelect = document.getElementById("estation");
    selectOptionByText(fromSelect, slot.from);
    selectOptionByText(toSelect, slot.to);

    log(`슬롯 ${slot.index + 1}: 새로고침 시작`);

    while (true) {
      const status = await sendToBackground({ type: "GET_AUTOMATION_STATUS" });
      if (!status?.running) return; // user pressed 중지, or already stopped elsewhere

      document.querySelector('button[onclick*="fnRmndrSeat"]')?.click();
      await sleep(randomBetween(260, 300));

      const seatButton = findSeatButtons()[0];
      if (!seatButton) continue;

      log(`슬롯 ${slot.index + 1}: 좌석 발견, 신청 시도`);
      seatButton.click(); // setInfo(N) — fills in 호차/좌석 above
      await sleep(150);

      lastAlert = null;
      document.querySelector('button[onclick*="seatRsvtn"]')?.click();

      const failed = await waitFor(() => lastAlert && lastAlert.time > Date.now() - 3000, 3000);
      if (failed) {
        log(`슬롯 ${slot.index + 1}: 신청 실패(${lastAlert.message}) — 재시도`);
        continue;
      }

      log(`슬롯 ${slot.index + 1}: 신청 완료`);
      await sendToBackground({ type: "SLOT_DONE", slotIndex: slot.index });
      return;
    }
  }

  function findSeatButtons() {
    return Array.from(document.querySelectorAll('button[onclick^="setInfo("]'));
  }

  // ---------- Station list (F1: 역 목록 읽어오기) ----------

  function readStationOptions() {
    const fromSelect = document.getElementById("sstation");
    const toSelect = document.getElementById("estation");
    if (!fromSelect || !toSelect) return null;
    const optionsOf = (select) =>
      Array.from(select.options)
        .map((o) => o.textContent.trim())
        .filter((text) => text && text !== "선택");
    return { stationsFrom: optionsOf(fromSelect), stationsTo: optionsOf(toSelect) };
  }

  // ---------- Generic DOM helpers ----------

  function findDateInput() {
    // 화면A(탑승신청)의 실제 id. 못 찾으면 일반 date input으로 대체.
    return document.getElementById("fromDtTm") || document.querySelector('input[type="date"]');
  }

  function findClickableByText(text) {
    const candidates = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"]'
    );
    return Array.from(candidates).find((el) => normalizeText(el.textContent) === text);
  }

  function selectOptionByText(select, text) {
    if (!select) return;
    const option = Array.from(select.options).find((o) => o.textContent.trim() === text);
    if (!option) return;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, "").trim();
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (predicate()) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function log(text) {
    sendToBackground({ type: "LOG", text });
  }

  function sendToBackground(message) {
    return chrome.runtime.sendMessage(message);
  }
})();
