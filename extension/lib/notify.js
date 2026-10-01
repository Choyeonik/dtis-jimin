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

async function sendDiscord(webhookUrl, message) {
  if (!webhookUrl) {
    return { channel: "디스코드", ok: false, detail: "웹훅 URL이 설정되지 않음(config.js)" };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) return { channel: "디스코드", ok: false, detail: `전송 실패 (HTTP ${res.status})` };
    return { channel: "디스코드", ok: true };
  } catch (err) {
    return { channel: "디스코드", ok: false, detail: `전송 실패 (${err})` };
  }
}
