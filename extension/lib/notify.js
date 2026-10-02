import { DISCORD_WEBHOOK_URL_SUCCESS, DISCORD_WEBHOOK_URL_STOP } from "../config.js";

// 디스코드는 웹훅 하나당 채널 하나라, "신청완료" 알림과 "중지" 알림을 다른
// 채널로 보내려면 웹훅도 두 개로 나눠야 한다.

// 전송 성공/실패를 결과로 돌려준다 — 예전엔 실패해도 조용히 넘어가서
// "설정을 안 채웠는지, 진짜 전송이 실패한 건지" 알 방법이 없었다.
export async function notifySuccess(message) {
  return [await sendDiscord(DISCORD_WEBHOOK_URL_SUCCESS, message)];
}

export async function notifyStop(message) {
  return [await sendDiscord(DISCORD_WEBHOOK_URL_STOP, message)];
}

// 이미 보낸 신청완료 메시지의 내용을 바꾼다(종료 취소 시 타이머 줄을 지우는 용도).
export async function editSuccessMessage(messageId, message) {
  try {
    const url = new URL(DISCORD_WEBHOOK_URL_SUCCESS);
    url.pathname += `/messages/${messageId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) return { channel: "디스코드", ok: false, detail: `메시지 수정 실패 (HTTP ${res.status})` };
    return { channel: "디스코드", ok: true };
  } catch (err) {
    return { channel: "디스코드", ok: false, detail: `메시지 수정 실패 (${err})` };
  }
}

async function sendDiscord(webhookUrl, message) {
  if (!webhookUrl) {
    return { channel: "디스코드", ok: false, detail: "웹훅 URL이 설정되지 않음(config.js)" };
  }
  try {
    // wait=true여야 디스코드가 보낸 메시지(id 포함)를 응답으로 돌려줘서, 나중에 수정할 수 있다.
    const url = new URL(webhookUrl);
    url.searchParams.set("wait", "true");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) return { channel: "디스코드", ok: false, detail: `전송 실패 (HTTP ${res.status})` };
    const sent = await res.json().catch(() => null);
    return { channel: "디스코드", ok: true, messageId: sent?.id ?? null };
  } catch (err) {
    return { channel: "디스코드", ok: false, detail: `전송 실패 (${err})` };
  }
}
