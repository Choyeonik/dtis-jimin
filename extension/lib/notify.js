import { DISCORD_WEBHOOK_URL, KAKAO_ACCESS_TOKEN } from "../config.js";

export async function notifyAll(message) {
  await Promise.allSettled([sendDiscord(message), sendKakao(message)]);
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
}

async function sendKakao(message) {
  if (!KAKAO_ACCESS_TOKEN) return;
  const templateObject = {
    object_type: "text",
    text: message,
    link: { web_url: "https://www.dtis.mil.kr/m/", mobile_web_url: "https://www.dtis.mil.kr/m/" },
  };
  const body = new URLSearchParams({
    template_object: JSON.stringify(templateObject),
  });
  await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KAKAO_ACCESS_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}
