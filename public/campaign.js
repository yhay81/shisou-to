const root = document.querySelector("[data-campaign-id]");
const campaignId = root.dataset.campaignId;
const mode = root.dataset.mode;
const sessionKey = "shisou_to_session";
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
const key = new URLSearchParams(window.location.hash.slice(1)).get("key") || "";
let currentState;

const errorMessages = {
  already_checked_today: "今日はすでに点灯しています。",
  already_joined_or_name_taken: "この端末では参加済みか、同じ表示名が使われています。",
  campaign_final: "終了した募集盤は変更できません。",
  campaign_not_running: "この試走は進行中ではありません。",
  contact_not_allowed_in_body: "気づきにメール、電話番号、URLは入れられません。",
  contact_not_allowed_in_displayName: "表示名にメール、電話番号、URLは入れられません。",
  contact_not_allowed_in_note: "メモにメール、電話番号、URLは入れられません。",
  feedback_limit_reached: "この参加札から送れる気づきは20件までです。",
  invalid_capability: "編集鍵を確認できません。保存した専用URLから開いてください。",
  optin_required: "先にGoogleで参加し、試走開始を点灯してください。",
  recruitment_closed: "この募集は終了しています。",
  test_window_complete: "14日分の試走期間を過ぎています。",
  tester_limit_reached: "この募集盤は参加上限に達しました。",
};

function privateHeaders(contentType = false) {
  const headers = {
    "X-Shisou-QA": automatedQa ? "1" : "0",
    "X-Shisou-Session": session,
  };
  if (key) headers["X-Shisou-Key"] = key;
  if (contentType) headers["Content-Type"] = "application/json";
  return headers;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "request_failed");
    error.code = body.error || "request_failed";
    error.status = response.status;
    throw error;
  }
  return body;
}

async function recordEvent(name) {
  try {
    await fetch("/api/telemetry", {
      body: JSON.stringify({ campaignId, name }),
      headers: privateHeaders(true),
      keepalive: true,
      method: "POST",
    });
  } catch {
    // 計測できない場合も試走盤は利用できます。
  }
}

function setText(selector, value) {
  document.querySelector(selector).textContent = String(value);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function renderDeviceWall(state) {
  const wall = document.querySelector("[data-device-wall]");
  wall.replaceChildren();
  for (let index = 0; index < state.campaign.targetCount; index += 1) {
    const light = document.createElement("i");
    if (index < state.counts.total) light.classList.add("lit");
    if (index < state.counts.completed) light.classList.add("complete");
    wall.append(light);
  }
}

function renderRunway(tester) {
  const checked = new Map(tester.checkins.map((item) => [item.dayIndex, item]));
  document.querySelectorAll("[data-runway-days] [data-day]").forEach((light) => {
    const day = Number(light.dataset.day);
    light.classList.toggle("current", day === tester.currentDay);
    light.classList.toggle("lit", checked.has(day));
    light.classList.toggle("blocked", checked.get(day)?.result === "blocked");
    light.title = checked.get(day)?.note || "";
  });
  setText(
    "[data-current-day]",
    tester.currentDay ? "DAY " + Math.min(tester.currentDay, 14) : "参加前",
  );
  setText("[data-completed-days]", tester.completedDays + " / 14 点灯");
  const todayDone = checked.has(tester.currentDay);
  document.querySelector("[data-confirm-optin]").hidden = Boolean(tester.optedInOn);
  document.querySelector("[data-checkin-form]").hidden =
    !tester.optedInOn || tester.currentDay < 1 || tester.currentDay > 14 || todayDone;
  if (todayDone) setText("[data-checkin-message]", "今日は点灯済みです。");
}

function progressCard(tester) {
  const card = document.createElement("article");
  card.className = "progress-card";
  card.dataset.status = tester.status;
  const device = document.createElement("span");
  device.className = "mini-device";
  const body = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = tester.displayName;
  const meta = document.createElement("p");
  meta.textContent = tester.deviceLabel + " · Android " + tester.androidVersion;
  const rail = document.createElement("div");
  rail.className = "mini-rail";
  for (let day = 1; day <= 14; day += 1) {
    const light = document.createElement("i");
    if (day <= tester.completedDays) light.classList.add("lit");
    rail.append(light);
  }
  const status = document.createElement("small");
  status.textContent = tester.optedInOn
    ? tester.completedDays + " / 14日 · " + tester.optedInOn + "開始"
    : tester.status === "withdrawn"
      ? "参加取消"
      : "Google参加待ち";
  body.append(heading, meta, rail, status);
  card.append(device, body);
  return card;
}

function renderManager(state) {
  const grid = document.querySelector("[data-progress-grid]");
  grid.replaceChildren();
  if (!state.testers.length) {
    const empty = document.createElement("p");
    empty.className = "empty-progress";
    empty.textContent = "参加札はまだありません。";
    grid.append(empty);
  } else {
    for (const tester of state.testers) grid.append(progressCard(tester));
  }
  const feedback = document.querySelector("[data-feedback-list]");
  feedback.replaceChildren();
  if (!state.feedback.length) {
    const empty = document.createElement("p");
    empty.className = "empty-feedback";
    empty.textContent = "気づきはまだ届いていません。";
    feedback.append(empty);
  } else {
    for (const item of state.feedback) {
      const card = document.createElement("article");
      const label = document.createElement("span");
      label.textContent = item.categoryLabel;
      const body = document.createElement("p");
      body.textContent = item.body;
      const author = document.createElement("small");
      author.textContent = item.displayName;
      card.append(label, body, author);
      feedback.append(card);
    }
  }
  document.querySelector("[data-notice-form]").elements.notice.value = state.campaign.notice;
  document.querySelector("[data-toggle-listing]").textContent = state.campaign.publicListing
    ? "一覧から隠す"
    : "一覧に表示";
  document.querySelector("[data-close-campaign]").textContent =
    state.campaign.status === "completed" ? "試走完了" : "募集を閉じる";
}

function render(state) {
  currentState = state;
  setText("[data-status]", state.campaign.statusLabel);
  setText("[data-app-name]", state.campaign.appName);
  setText("[data-genre]", state.campaign.genreLabel);
  setText("[data-tester-count]", state.counts.total);
  setText("[data-target-count]", state.campaign.targetCount);
  setText("[data-capacity-readout]", state.counts.total + " / " + state.campaign.targetCount);
  setText("[data-summary]", state.campaign.summary);
  setText(
    "[data-test-focus]",
    state.campaign.testFocus || "自由に使って、止まった場所を知らせてください。",
  );
  setText("[data-notice]", state.campaign.notice);
  document.querySelector("[data-notice-panel]").hidden = !state.campaign.notice;
  document.querySelector("[data-group-link]").href = state.campaign.groupUrl;
  document.querySelector("[data-play-link]").href = state.campaign.playUrl;
  renderDeviceWall(state);

  if (mode === "manage") {
    document.querySelector("[data-join-desk]").hidden = true;
    document.querySelector("[data-manager-console]").hidden = false;
    renderManager(state);
  } else if (mode === "tester" && state.tester) {
    document.querySelector("[data-join-desk]").hidden = true;
    document.querySelector("[data-tester-console]").hidden = false;
    setText("[data-tester-name]", state.tester.displayName);
    renderRunway(state.tester);
  } else if (!new Set(["recruiting", "running"]).has(state.campaign.status)) {
    document
      .querySelector("[data-join-form]")
      .querySelectorAll("input,select,button")
      .forEach((control) => {
        control.disabled = true;
      });
    setText("[data-join-message]", "この募集は終了しています。");
  }

  document.querySelector("[data-loading]").hidden = true;
  document.querySelector("[data-campaign-app]").hidden = false;
}

async function loadState() {
  const suffix = mode === "manage" ? "/manage" : mode === "tester" ? "/tester" : "";
  try {
    const state = await requestJson("/api/campaigns/" + campaignId + suffix, {
      headers: privateHeaders(),
    });
    render(state);
    if (mode === "campaign") void recordEvent("public_campaign_viewed");
  } catch (error) {
    document.querySelector("[data-loading]").hidden = true;
    document.querySelector("[data-error]").hidden = false;
    setText(
      "[data-error-message]",
      errorMessages[error.code] || "URL、募集期間、専用の編集鍵を確認してください。",
    );
  }
}

document.querySelector("[data-join-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const message = form.querySelector("[data-join-message]");
  submit.disabled = true;
  message.textContent = "";
  try {
    const result = await requestJson("/api/campaigns/" + campaignId + "/join", {
      body: JSON.stringify({
        androidVersion: form.elements.androidVersion.value,
        deviceKind: form.elements.deviceKind.value,
        displayName: form.elements.displayName.value,
        website: form.elements.website.value,
      }),
      headers: privateHeaders(true),
      method: "POST",
    });
    message.textContent = "参加札を作りました。自分の試走ページへ移動します。";
    window.location.assign(result.testerUrl);
  } catch (error) {
    message.textContent =
      errorMessages[error.code] || "参加できませんでした。入力を確認してください。";
    submit.disabled = false;
  }
});

document.querySelector("[data-confirm-optin]").addEventListener("click", async () => {
  try {
    await requestJson("/api/campaigns/" + campaignId + "/opt-in", {
      headers: privateHeaders(true),
      method: "POST",
    });
    await loadState();
  } catch (error) {
    window.alert(errorMessages[error.code] || "試走を開始できませんでした。");
  }
});

document.querySelector("[data-checkin-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const message = form.querySelector("[data-checkin-message]");
  submit.disabled = true;
  try {
    await requestJson("/api/campaigns/" + campaignId + "/check-in", {
      body: JSON.stringify({ note: form.elements.note.value, result: form.elements.result.value }),
      headers: privateHeaders(true),
      method: "POST",
    });
    message.textContent = "今日の試走を点灯しました。";
    await loadState();
  } catch (error) {
    message.textContent = errorMessages[error.code] || "今日を点灯できませんでした。";
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("[data-feedback-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.querySelector("[data-feedback-message]");
  try {
    await requestJson("/api/campaigns/" + campaignId + "/feedback", {
      body: JSON.stringify({
        body: form.elements.body.value,
        category: form.elements.category.value,
      }),
      headers: privateHeaders(true),
      method: "POST",
    });
    form.reset();
    message.textContent = "開発者へ送りました。";
  } catch (error) {
    message.textContent = errorMessages[error.code] || "気づきを送れませんでした。";
  }
});

document.querySelector("[data-withdraw]").addEventListener("click", async () => {
  if (!window.confirm("この試走への参加を取り消しますか？")) return;
  await requestJson("/api/campaigns/" + campaignId + "/withdraw", {
    headers: privateHeaders(true),
    method: "POST",
  });
  window.location.assign("/c/" + campaignId);
});

document.querySelectorAll("[data-group-link],[data-play-link]").forEach((link) => {
  link.addEventListener("click", () => void recordEvent("official_link_opened"));
});

document.querySelector("[data-notice-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await requestJson("/api/campaigns/" + campaignId + "/manage", {
      body: JSON.stringify({ notice: event.currentTarget.elements.notice.value }),
      headers: privateHeaders(true),
      method: "PATCH",
    });
    await loadState();
  } catch {
    window.alert("お知らせを更新できませんでした。");
  }
});

document.querySelector("[data-toggle-listing]").addEventListener("click", async () => {
  try {
    await requestJson("/api/campaigns/" + campaignId + "/manage", {
      body: JSON.stringify({ publicListing: !currentState.campaign.publicListing }),
      headers: privateHeaders(true),
      method: "PATCH",
    });
    await loadState();
  } catch {
    window.alert("一覧表示を変更できませんでした。");
  }
});

document.querySelector("[data-close-campaign]").addEventListener("click", async () => {
  if (!window.confirm("この募集を終了しますか？再開はできません。")) return;
  try {
    await requestJson("/api/campaigns/" + campaignId + "/manage", {
      body: JSON.stringify({ status: "closed" }),
      headers: privateHeaders(true),
      method: "PATCH",
    });
    await loadState();
  } catch {
    window.alert("募集を終了できませんでした。");
  }
});

async function downloadPrivate(kind) {
  const response = await fetch("/api/campaigns/" + campaignId + "/roster." + kind, {
    headers: privateHeaders(),
  });
  if (!response.ok) throw new Error("download_failed");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "shisou-" + campaignId.slice(0, 8) + "." + kind;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelector("[data-export-csv]").addEventListener("click", async (event) => {
  event.preventDefault();
  await downloadPrivate("csv").catch(() => window.alert("CSVを書き出せませんでした。"));
});

document.querySelector("[data-export-json]").addEventListener("click", async (event) => {
  event.preventDefault();
  await downloadPrivate("json").catch(() => window.alert("JSONを書き出せませんでした。"));
});

document.querySelector("[data-copy-public]").addEventListener("click", async (event) => {
  await copyText(window.location.origin + "/c/" + campaignId);
  event.currentTarget.textContent = "コピーしました";
});

document.querySelector("[data-share]").addEventListener("click", async () => {
  const publicUrl = window.location.origin + "/c/" + campaignId;
  if (navigator.share) {
    await navigator.share({
      title: currentState?.campaign.appName || "Androidテスト募集",
      url: publicUrl,
    });
  } else {
    await copyText(publicUrl);
  }
});

document.querySelector("[data-report]").addEventListener("click", async () => {
  if (!window.confirm("迷惑・危険な募集として報告しますか？")) return;
  try {
    await requestJson("/api/campaigns/" + campaignId + "/report", {
      body: JSON.stringify({ reason: "unsafe" }),
      headers: privateHeaders(true),
      method: "POST",
    });
    window.alert("報告を受け付けました。");
  } catch {
    window.alert("報告済みか、送信できませんでした。");
  }
});

void loadState();
