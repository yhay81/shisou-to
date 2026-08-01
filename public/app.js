const sessionKey = "shisou_to_session";
const seenKey = "shisou_to_seen";
const automatedQa =
  new URLSearchParams(window.location.search).get("qa") === "1" || navigator.webdriver === true;

function sessionId() {
  if (automatedQa) return crypto.randomUUID();
  const existing = localStorage.getItem(sessionKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(sessionKey, created);
  return created;
}

const session = sessionId();

async function recordEvent(name, campaignId = "") {
  const headers = { "Content-Type": "application/json", "X-Shisou-Session": session };
  if (automatedQa) headers["X-Shisou-QA"] = "1";
  try {
    await fetch("/api/telemetry", {
      body: JSON.stringify({ campaignId, name }),
      headers,
      keepalive: true,
      method: "POST",
    });
  } catch {
    // 計測できない場合も募集盤は利用できます。
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "request_failed");
    error.code = body.error || "request_failed";
    throw error;
  }
  return body;
}

const errorMessages = {
  contact_not_allowed_in_appName: "アプリ名にメール、電話番号、URLは入れられません。",
  contact_not_allowed_in_summary: "説明にメール、電話番号、URLは入れられません。",
  contact_not_allowed_in_testFocus: "テスト観点にメール、電話番号、URLは入れられません。",
  create_rate_limited: "1日に作れる募集盤は3件までです。",
  invalid_groupUrl: "Google Groupsの /g/ で始まるグループURLを入力してください。",
  invalid_playUrl: "Google Playの /apps/testing/ で始まるテスト参加URLを入力してください。",
  invalid_targetCount: "目標人数は12〜30人で入力してください。",
};

const form = document.querySelector("[data-create-form]");

document.querySelector("[data-open-create]").addEventListener("click", () => {
  document.querySelector("#create-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.appName.focus({ preventScroll: true });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  const message = form.querySelector("[data-form-message]");
  message.textContent = "";
  submit.disabled = true;
  submit.textContent = "募集盤を点検中…";
  try {
    const result = await requestJson("/api/campaigns", {
      body: JSON.stringify({
        appName: form.elements.appName.value,
        genre: form.elements.genre.value,
        groupUrl: form.elements.groupUrl.value,
        playUrl: form.elements.playUrl.value,
        publicListing: form.elements.publicListing.checked,
        summary: form.elements.summary.value,
        targetCount: Number(form.elements.targetCount.value),
        testFocus: form.elements.testFocus.value,
        website: form.elements.website.value,
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Shisou-QA": automatedQa ? "1" : "0",
        "X-Shisou-Session": session,
      },
      method: "POST",
    });
    message.textContent = "募集盤を開きました。開発者ページへ移動します。";
    window.location.assign(result.manageUrl);
  } catch (error) {
    message.textContent =
      errorMessages[error.code] || "募集盤を作れませんでした。入力と通信状態を確認してください。";
    submit.disabled = false;
    submit.textContent = "募集盤を開く";
  }
});

void recordEvent("visited");
if (!automatedQa && localStorage.getItem(seenKey) === "1") void recordEvent("returned");
if (!automatedQa) localStorage.setItem(seenKey, "1");
