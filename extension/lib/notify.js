import { DISCORD_WEBHOOK_URL, KAKAO_ACCESS_TOKEN } from "../config.js";

// 각 채널의 성공/실패를 결과로 돌려준다 — 예전엔 실패해도 조용히 넘어가서
// "설정을 안 채웠는지, 진짜 전송이 실패한 건지" 알 방법이 없었다.
export async function notifyAll(message) {
  return Promise.all([sendDiscord(message), sendKakao(message)]);
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) {
    return { channel: "디스코드", ok: false, detail: "웹훅 URL이 설정되지 않음(config.js)" };
  }
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
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

async function sendKakao(message) {
  if (!KAKAO_ACCESS_TOKEN) {
    return { channel: "카카오", ok: false, detail: "액세스 토큰이 설정되지 않음(config.js)" };
  }
  try {
    const templateObject = {
      object_type: "text",
      text: message,
      link: { web_url: "https://www.dtis.mil.kr/m/", mobile_web_url: "https://www.dtis.mil.kr/m/" },
    };
    const body = new URLSearchParams({ template_object: JSON.stringify(templateObject) });
    const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KAKAO_ACCESS_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) return { channel: "카카오", ok: false, detail: `전송 실패 (HTTP ${res.status})` };
    return { channel: "카카오", ok: true };
  } catch (err) {
    return { channel: "카카오", ok: false, detail: `전송 실패 (${err})` };
  }
}
