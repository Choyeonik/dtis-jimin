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
    if (msg.type === "AUTOMATION_STARTED") {
      checkAndAct();
    }
    if (msg.type === "FETCH_STATIONS_STARTED") {
      checkFetchAndAct();
    }
    if (msg.type === "CONTINUE_RETURN") {
      checkReturnAndAct();
    }
  });

  checkAndAct();
  checkFetchAndAct();
  checkReturnAndAct();

  // ---------- Return to screen A (F8: 슬롯 전환 / 역 목록 읽기 후 복귀) ----------
  // 화면B가 실제 페이지 이동인지 같은 페이지 안의 팝업인지 확실치 않으므로, 고정된
  // 횟수만큼 "이전"을 누르지 않고 화면A에 도착할 때까지 반복 클릭한다. 클릭이 실제
  // 페이지 이동이면 스크립트가 새로 실행되며 이 함수가 다시 불려 이어서 판단하고,
  // 같은 페이지 안의 전환이면 이 루프 안에서 곧바로 다음 클릭으로 넘어간다.

  async function checkReturnAndAct() {
    const status = await sendToBackground({ type: "GET_RETURN_STATUS" });
    if (!status?.returning) return;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (isScreenA()) {
        await sendToBackground({ type: "RETURN_DONE" });
        // 이미 화면A에 있으면(신청 성공 후 alert 없이 곧바로 여기로 돌아온 경우 등)
        // 페이지 이동이 전혀 없어서 checkAndAct()가 다시 불릴 계기가 없다 — 다음
        // 슬롯이 이미 대기 중일 수 있으니 여기서 바로 확인한다.
        await checkAndAct();
        return;
      }
      const backButton = findClickableContaining("이전");
      if (!backButton) {
        log("'이전' 버튼을 찾지 못해 화면A 복귀를 중단함");
        await sendToBackground({ type: "RETURN_DONE" });
        return;
      }
      backButton.click();
      await sleep(400);
      // 방금 클릭이 실제 페이지 이동이었다면 이 지점의 스크립트 컨텍스트는 이미
      // 사라졌고, 새 페이지에서 checkReturnAndAct()가 처음부터 다시 실행된다.
    }
  }

  async function checkAndAct() {
    const status = await sendToBackground({ type: "GET_AUTOMATION_STATUS" });
    if (!status?.running || !status.currentSlot) return;
    const slot = status.currentSlot;

    // 좌석신청이 실패하면 화면C에 그대로 남고, 성공하면 alert 없이 곧바로 다른
    // 화면으로 넘어가버릴 수 있다(그 경우 runScreenC의 스크립트 컨텍스트가 페이지
    // 이동과 함께 사라져 SLOT_DONE을 보낼 기회조차 없다). 그래서 "신청을 시도해뒀는데
    // 화면C가 아니게 됐다"는 사실 자체를 성공 신호로 쓴다 — 새로 뜬 이 페이지에서
    // 확인해 SLOT_DONE을 대신 보낸다.
    if (slot.pendingTicket && !isScreenC()) {
      log(`슬롯 ${slot.index + 1}: 화면 전환이 감지되어 신청 완료로 처리`);
      await sendToBackground({ type: "SLOT_DONE", slotIndex: slot.index, ticket: slot.pendingTicket });
      return;
    }

    await handleCurrentScreen(slot);
  }

  // ---------- Station list fetch flow (F1) ----------
  // 날짜를 입력하고 "조회"만 누른 뒤, 그 결과 테이블에 실제로 나온 출발역/도착역만
  // 읽어서 돌려준다. 예약가능/확인 등 실제 예약 절차에는 전혀 들어가지 않는다
  // (그 절차는 사용자가 출발역/도착역/오전·오후를 고른 뒤 "시작"을 눌렀을 때
  // runScreenA()가 조건에 맞는 행을 찾아 진행한다).
  //
  // 진행 중에 사용자가 날짜를 다시 바꾸면 background가 fetchToken을 올리고
  // FETCH_STATIONS_STARTED를 다시 보낸다 — 그 순간 activeFetchToken이 갱신되므로,
  // 조회 결과를 기다리던 이전 실행은 자기 token이 낡았음을 감지하고 결과를 보내지
  // 않은 채 조용히 멈춘다(이후는 새로 시작된 실행이 이어서 진행).

  let activeFetchToken = null;

  async function checkFetchAndAct() {
    const status = await sendToBackground({ type: "GET_FETCH_STATUS" });
    if (!status?.fetching) return;
    activeFetchToken = status.token;
    await handleFetchScreen(status.date, status.token);
  }

  async function handleFetchScreen(date, token) {
    if (!isScreenA()) {
      logFetch(`화면A가 아닌 곳에 있어 중단함 (${location.pathname})`);
      await sendToBackground({ type: "FETCH_STATIONS_FAILED", reason: "탑승신청 화면이 아니라 조회할 수 없습니다.", token });
      return;
    }

    logFetch(`화면A, 날짜(${date}) 입력 후 조회`);
    const dateInput = findDateInput();
    if (dateInput && date && dateInput.value !== date) {
      setNativeValue(dateInput, date);
      dateInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    findClickableByText("조회")?.click();

    // "조회된 데이터가 없습니다" 안내도 tr.m_table_html_tr로 렌더링되는 경우가 있어
    // 행이 있다고 오판할 수 있다 — 실제 "예약가능" 버튼이 있는 행만 유효한 결과로 본다.
    await waitFor(() => findBookableRows().length > 0 || findResultRows().length > 0, 4000);
    if (token !== activeFetchToken) return; // 날짜가 또 바뀌어 낡은 실행이 됨 — 멈춤

    const rows = findBookableRows();
    if (rows.length === 0) {
      await sendToBackground({ type: "FETCH_STATIONS_FAILED", reason: "조회된 목록이 없습니다.", token });
      return;
    }

    const result = extractStations(rows);
    logFetch(`조회 결과 ${rows.length}건, 출발역 ${result.stationsFrom.length}개 / 도착역 ${result.stationsTo.length}개 읽음`);
    await sendToBackground({ type: "FETCH_STATIONS_RESULT", result, token });
  }

  // 결과 테이블의 출발역/도착역 칸은 "역명 10:00"처럼 시간이 붙어 있어, 첫 숫자
  // 앞까지만 역명으로 본다(rowMatchesSlot의 startsWith 가정과 동일).
  function extractStations(rows) {
    const fromSet = new Set();
    const toSet = new Set();
    rows.forEach((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 7) return;
      const from = stationNameFromCellText(cells[5].textContent);
      const to = stationNameFromCellText(cells[6].textContent);
      if (from) fromSet.add(from);
      if (to) toSet.add(to);
    });
    return { stationsFrom: Array.from(fromSet), stationsTo: Array.from(toSet) };
  }

  function stationNameFromCellText(text) {
    return (text || "").replace(/\d.*$/, "").trim();
  }

  function logFetch(text) {
    log(`역 목록 읽기: ${text}`);
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

    // 화면C의 잔여석 표에는 시간이 안 적혀 있어서, 지금 이 행("역명 10:00")에서
    // 미리 시간을 뽑아 background에 남겨둔다 — 나중에 완료 알림에 쓴다.
    const cells = match.querySelectorAll("td");
    const departTime = cells[5]?.textContent.match(/\d{1,2}:\d{2}/)?.[0] || null;
    const arriveTime = cells[6]?.textContent.match(/\d{1,2}:\d{2}/)?.[0] || null;
    await sendToBackground({ type: "TRAIN_MATCHED", slotIndex: slot.index, departTime, arriveTime });

    log(`슬롯 ${slot.index + 1}: 조건에 맞는 열차 발견, 예약가능 클릭`);
    match.querySelector("button.m_btn_106")?.click();
    // linkPage01_01_2(id, date, 1) navigates to Screen B; script re-runs fresh on the new page.
  }

  function findResultRows() {
    return Array.from(document.querySelectorAll("#m_table_02 tr.m_table_html_tr"));
  }

  // "조회된 데이터가 없습니다" 안내 행도 findResultRows()에 걸릴 수 있어, 실제로
  // "예약가능" 버튼이 있는 행만 걸러낸다.
  function findBookableRows() {
    return findResultRows().filter((row) => row.querySelector("button.m_btn_106"));
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

      // 표에 좌석이 떠도 승차역/하차역이 다른 구간(그 열차가 지나가는 다른 역 사이)
      // 좌석이 섞여 있을 수 있다 — 슬롯의 출발역/도착역과 일치하는 좌석만 고른다.
      const seatButton = findMatchingSeatButton(slot);
      if (!seatButton) continue;

      const ticket = extractTicketInfo(seatButton.closest("tr"), slot);

      log(`슬롯 ${slot.index + 1}: 좌석 발견, 신청 시도`);
      seatButton.click(); // setInfo(N) — fills in 호차/좌석 above
      await sleep(150);

      lastAlert = null;
      // 성공하면 alert 없이 곧바로 화면이 넘어갈 수 있어(그러면 이 스크립트는 그 순간
      // 사라진다), 클릭하기 전에 먼저 "이 티켓을 신청해뒀다"고 background에 남겨둔다.
      // 화면C를 벗어난 채로 다시 로드되면 checkAndAct()가 이걸 성공으로 처리한다.
      await sendToBackground({ type: "SEAT_APPLY_STARTED", slotIndex: slot.index, ticket });
      document.querySelector('button[onclick*="seatRsvtn"]')?.click();

      const alerted = await waitFor(() => lastAlert && lastAlert.time > Date.now() - 3000, 3000);
      // "탑승신청이 완료되었습니다." 같은 성공 alert도 뜬다 — "완료"가 없는 alert만
      // ("다른 사람이 먼저 선택했습니다", "중복된 구간이 있습니다" 등) 실패로 본다.
      if (alerted && !lastAlert.message.includes("완료")) {
        await sendToBackground({ type: "SEAT_APPLY_FAILED", slotIndex: slot.index });
        if (lastAlert.message.includes("중복")) {
          // 이미 예약되어 있어서 나는 실패라, 재시도해도 계속 똑같이 막힌다 — 중단.
          log(`슬롯 ${slot.index + 1}: 신청 중단(${lastAlert.message}) — 이미 예약된 것으로 보임`);
          await sendToBackground({ type: "DUPLICATE_BOOKING", slotIndex: slot.index, reason: lastAlert.message });
          return;
        }
        log(`슬롯 ${slot.index + 1}: 신청 실패(${lastAlert.message}) — 재시도`);
        continue;
      }

      // 아직 화면C에 남아있다면(=페이지 이동 없이 여기까지 옴) alert도 없었으니 성공으로 본다.
      // 이미 화면이 넘어가버렸다면 이 줄에 도달하기 전에 스크립트가 사라졌을 것이고,
      // 그 경우는 checkAndAct()의 pendingTicket 확인이 대신 SLOT_DONE을 보낸다.
      log(`슬롯 ${slot.index + 1}: 신청 완료${alerted ? `(${lastAlert.message})` : ""}`);
      await sendToBackground({ type: "SLOT_DONE", slotIndex: slot.index, ticket });
      return;
    }
  }

  function findSeatButtons() {
    return Array.from(document.querySelectorAll('button[onclick^="setInfo("]'));
  }

  // 잔여석예약 표의 컬럼 순서: 선택(0) 호차(1) 좌석(2) 출발역(3) 도착역(4).
  function findMatchingSeatButton(slot) {
    return findSeatButtons().find((btn) => {
      const cells = btn.closest("tr")?.querySelectorAll("td");
      if (!cells || cells.length < 5) return false;
      const from = cells[3].textContent.trim();
      const to = cells[4].textContent.trim();
      return from.startsWith(slot.from) && to.startsWith(slot.to);
    });
  }

  // 출발역/도착역 칸("역명 10:00")에서 실제 신청한 시간까지 뽑아 완료 알림에 쓴다.
  // 화면C의 잔여석 표에는 시간이 없는 경우가 많아, 화면A에서 미리 붙잡아둔
  // slot.departTime/arriveTime(TRAIN_MATCHED로 저장됨)을 우선 쓴다.
  function extractTicketInfo(row, slot) {
    const cells = row?.querySelectorAll("td");
    const fromText = cells?.[3]?.textContent.trim() || slot.from;
    const toText = cells?.[4]?.textContent.trim() || slot.to;
    return {
      date: slot.date,
      from: stationNameFromCellText(fromText) || slot.from,
      to: stationNameFromCellText(toText) || slot.to,
      departTime: slot.departTime || fromText.match(/\d{1,2}:\d{2}/)?.[0] || "-",
      arriveTime: slot.arriveTime || toText.match(/\d{1,2}:\d{2}/)?.[0] || "-",
    };
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

  // "< 이전"처럼 화살표 아이콘이 텍스트에 섞여 있을 수 있는 버튼을 위해 포함 여부로 찾는다.
  function findClickableContaining(text) {
    const candidates = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"]'
    );
    return Array.from(candidates).find((el) => normalizeText(el.textContent).includes(text));
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
