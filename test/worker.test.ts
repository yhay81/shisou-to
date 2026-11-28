import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app, scheduled, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_campaigns.sql", import.meta.url));
const appScriptPath = fileURLToPath(new URL("../public/app.js", import.meta.url));
const campaignScriptPath = fileURLToPath(new URL("../public/campaign.js", import.meta.url));
const ogPath = fileURLToPath(new URL("../public/og.svg", import.meta.url));
const stylesPath = fileURLToPath(new URL("../public/styles.css", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const origin = "http://localhost";
const sessions = [
  "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a",
  "b3d0e2f2-66fd-4fd4-8e87-b0ef67ad194b",
  "c4d0e2f2-66fd-4fd4-8e87-b0ef67ad194c",
  "d5d0e2f2-66fd-4fd4-8e87-b0ef67ad194d",
  "e6d0e2f2-66fd-4fd4-8e87-b0ef67ad194e",
  "f7d0e2f2-66fd-4fd4-8e87-b0ef67ad194f",
  "a8d0e2f2-66fd-4fd4-8e87-b0ef67ad1940",
  "b9d0e2f2-66fd-4fd4-8e87-b0ef67ad1941",
];

let miniflare: Miniflare;
let bindings: Bindings;

const headers = (session = sessions[0], key = "", qa = false) => ({
  "content-type": "application/json",
  origin,
  "x-shisou-key": key,
  "x-shisou-qa": qa ? "1" : "0",
  "x-shisou-session": session,
});

const validCampaign = (overrides: Record<string, unknown> = {}) => ({
  appName: "歩数を灯す",
  genre: "lifestyle",
  groupUrl: "https://groups.google.com/g/example-testers",
  playUrl: "https://play.google.com/apps/testing/com.example.shisou",
  publicListing: true,
  summary: "散歩の記録を小さな灯りに変えるアプリです。",
  targetCount: 12,
  testFocus: "端末を再起動した後も記録が続くか見てください。",
  website: "",
  ...overrides,
});

const keyFromUrl = (url: string) =>
  new URLSearchParams(new URL(url, origin).hash.slice(1)).get("key") ?? "";

const createCampaign = async (
  overrides: Record<string, unknown> = {},
  session = sessions[0],
  qa = false,
) => {
  const response = await app.request(
    "/api/campaigns",
    {
      body: JSON.stringify(validCampaign(overrides)),
      headers: headers(session, "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; manageUrl: string; publicUrl: string }>();
  return { ...body, managerKey: keyFromUrl(body.manageUrl) };
};

const joinCampaign = async (
  campaignId: string,
  sessionIndex = 1,
  overrides: Record<string, unknown> = {},
  qa = false,
) => {
  const response = await app.request(
    `/api/campaigns/${campaignId}/join`,
    {
      body: JSON.stringify({
        androidVersion: "15",
        deviceKind: "phone",
        displayName: `試走者${sessionIndex}`,
        website: "",
        ...overrides,
      }),
      headers: headers(sessions[sessionIndex], "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; testerUrl: string }>();
  return { ...body, testerKey: keyFromUrl(body.testerUrl) };
};

beforeEach(async () => {
  miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: "",
          compatibilityDate: "2026-07-27",
          env: { DB: { type: "d1", id: "shisou-to-test" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: "export default { fetch() { return new Response('test') } }",
              },
            },
          },
        },
      },
    ],
  });
  const database = await miniflare.getD1Database("DB");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
  bindings = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: database as unknown as D1Database,
  };
});

afterEach(async () => miniflare.dispose());

describe("public pages", () => {
  it.each([
    ["/", 'class="runway-preview"', "https://shisou-to.yhay81.com/"],
    ["/guide", 'class="guide-cards"', "https://shisou-to.yhay81.com/guide"],
    ["/requirements", 'class="requirement-visual"', "https://shisou-to.yhay81.com/requirements"],
    ["/privacy", 'class="data-grid"', "https://shisou-to.yhay81.com/privacy"],
  ])("%s returns a product-specific surface", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(html).toContain("試走灯");
    expect(html).not.toMatch(/仮説|成功条件|市場スコア/u);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("publishes only the four indexable pages", async () => {
    const response = await app.request("/sitemap.xml", undefined, bindings);
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml.match(/<loc>/gu)).toHaveLength(4);
    expect(xml).not.toContain("/c/");
    expect(await (await app.request("/health", undefined, bindings)).json()).toEqual({ ok: true });
  });

  it("marks campaign, manager, and tester screens noindex", async () => {
    const campaign = await createCampaign();
    for (const [path, mode] of [
      [`/c/${campaign.id}`, "campaign"],
      [`/m/${campaign.id}`, "manage"],
      [`/t/${campaign.id}`, "tester"],
    ]) {
      const response = await app.request(path, undefined, bindings);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('content="noindex,nofollow" name="robots"');
      expect(html).toContain(`data-mode="${mode}"`);
    }
  });
});

describe("campaign creation", () => {
  it("creates a campaign without leaking the manager key", async () => {
    const campaign = await createCampaign();
    const publicResponse = await app.request(`/api/campaigns/${campaign.id}`, undefined, bindings);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).not.toContain(campaign.managerKey);
    const denied = await app.request(
      `/api/campaigns/${campaign.id}/manage`,
      { headers: headers() },
      bindings,
    );
    expect(denied.status).toBe(403);
    const allowed = await app.request(
      `/api/campaigns/${campaign.id}/manage`,
      { headers: headers(sessions[0], campaign.managerKey) },
      bindings,
    );
    expect(allowed.status).toBe(200);
  });

  it("renders public campaigns safely and omits unlisted campaigns", async () => {
    await createCampaign({ appName: "<試走アプリ>" });
    await createCampaign({ appName: "限定走行", publicListing: false }, sessions[1]);
    const html = await (await app.request("/", undefined, bindings)).text();
    expect(html).toContain("&lt;試走アプリ&gt;");
    expect(html).not.toContain("限定走行");
  });

  it.each([
    [{ groupUrl: "https://example.com/g/testers" }, "invalid_groupUrl"],
    [{ playUrl: "https://example.com/apps/testing/example" }, "invalid_playUrl"],
    [{ appName: "help@example.com" }, "contact_not_allowed_in_appName"],
    [{ website: "bot" }, "invalid_request"],
  ])("rejects unsafe campaign input %#", async (overrides, error) => {
    const response = await app.request(
      "/api/campaigns",
      {
        body: JSON.stringify(validCampaign(overrides)),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
  });

  it("rejects cross-origin creation and limits one session to three campaigns per day", async () => {
    const crossOrigin = await app.request(
      "/api/campaigns",
      {
        body: JSON.stringify(validCampaign()),
        headers: { ...headers(), origin: "https://evil.example" },
        method: "POST",
      },
      bindings,
    );
    expect(crossOrigin.status).toBe(403);
    await createCampaign();
    await createCampaign();
    await createCampaign();
    const limited = await app.request(
      "/api/campaigns",
      {
        body: JSON.stringify(validCampaign()),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(limited.status).toBe(429);
  });
});

describe("tester run", () => {
  it("prevents duplicate sessions, duplicate names, and contact details", async () => {
    const campaign = await createCampaign();
    await joinCampaign(campaign.id, 1, { displayName: "青葉" });

    const duplicateSession = await app.request(
      `/api/campaigns/${campaign.id}/join`,
      {
        body: JSON.stringify({
          androidVersion: "15",
          deviceKind: "phone",
          displayName: "別名",
          website: "",
        }),
        headers: headers(sessions[1]),
        method: "POST",
      },
      bindings,
    );
    expect(duplicateSession.status).toBe(409);

    const duplicateName = await app.request(
      `/api/campaigns/${campaign.id}/join`,
      {
        body: JSON.stringify({
          androidVersion: "15",
          deviceKind: "tablet",
          displayName: "青葉",
          website: "",
        }),
        headers: headers(sessions[2]),
        method: "POST",
      },
      bindings,
    );
    expect(duplicateName.status).toBe(409);

    const contact = await app.request(
      `/api/campaigns/${campaign.id}/join`,
      {
        body: JSON.stringify({
          androidVersion: "15",
          deviceKind: "phone",
          displayName: "user@example.com",
          website: "",
        }),
        headers: headers(sessions[3]),
        method: "POST",
      },
      bindings,
    );
    expect(contact.status).toBe(400);
  });

  it("tracks opt-in, today's run, and feedback on the manager board", async () => {
    const campaign = await createCampaign();
    const tester = await joinCampaign(campaign.id, 1, { displayName: "朝の端末" });

    const initial = await (
      await app.request(
        `/api/campaigns/${campaign.id}/tester`,
        { headers: headers(sessions[1], tester.testerKey) },
        bindings,
      )
    ).json<{ tester: { completedDays: number; currentDay: number; status: string } }>();
    expect(initial.tester).toMatchObject({ completedDays: 0, currentDay: 0, status: "joined" });

    const optedIn = await app.request(
      `/api/campaigns/${campaign.id}/opt-in`,
      { headers: headers(sessions[1], tester.testerKey), method: "POST" },
      bindings,
    );
    expect(optedIn.status).toBe(200);
    expect(await optedIn.json()).toMatchObject({ currentDay: 1 });

    const checkin = await app.request(
      `/api/campaigns/${campaign.id}/check-in`,
      {
        body: JSON.stringify({ note: "起動と記録を確認", result: "used" }),
        headers: headers(sessions[1], tester.testerKey),
        method: "POST",
      },
      bindings,
    );
    expect(checkin.status).toBe(200);
    expect(await checkin.json()).toMatchObject({ completedDays: 1, dayIndex: 1 });

    const duplicate = await app.request(
      `/api/campaigns/${campaign.id}/check-in`,
      {
        body: JSON.stringify({ note: "", result: "used" }),
        headers: headers(sessions[1], tester.testerKey),
        method: "POST",
      },
      bindings,
    );
    expect(duplicate.status).toBe(409);

    const feedback = await app.request(
      `/api/campaigns/${campaign.id}/feedback`,
      {
        body: JSON.stringify({
          body: "記録ボタンの反応が少し分かりにくいです。",
          category: "usability",
        }),
        headers: headers(sessions[1], tester.testerKey),
        method: "POST",
      },
      bindings,
    );
    expect(feedback.status).toBe(201);

    const managed = await (
      await app.request(
        `/api/campaigns/${campaign.id}/manage`,
        { headers: headers(sessions[0], campaign.managerKey) },
        bindings,
      )
    ).json<{
      feedback: Array<{ body: string; displayName: string }>;
      testers: Array<{ completedDays: number; status: string }>;
    }>();
    expect(managed.testers[0]).toMatchObject({ completedDays: 1, status: "testing" });
    expect(managed.feedback[0]).toMatchObject({ displayName: "朝の端末" });
  });

  it("rejects check-ins outside the individual 14-day window", async () => {
    const campaign = await createCampaign();
    const tester = await joinCampaign(campaign.id);
    await bindings.DB.prepare(
      "UPDATE testers SET status = 'testing', opted_in_on = '2020-01-01' WHERE id = ?",
    )
      .bind(tester.id)
      .run();
    const response = await app.request(
      `/api/campaigns/${campaign.id}/check-in`,
      {
        body: JSON.stringify({ note: "", result: "used" }),
        headers: headers(sessions[1], tester.testerKey),
        method: "POST",
      },
      bindings,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "test_window_complete" });
  });

  it("lets a tester withdraw", async () => {
    const campaign = await createCampaign();
    const tester = await joinCampaign(campaign.id);
    const response = await app.request(
      `/api/campaigns/${campaign.id}/withdraw`,
      { headers: headers(sessions[1], tester.testerKey), method: "POST" },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ withdrawn: true });
  });
});

describe("developer controls and safety", () => {
  it("updates the notice, public listing, and final status with the manager key", async () => {
    const campaign = await createCampaign();
    for (const payload of [
      { notice: "Android 15の端末を特に確認中です。" },
      { publicListing: false },
      { status: "closed" },
    ]) {
      const response = await app.request(
        `/api/campaigns/${campaign.id}/manage`,
        {
          body: JSON.stringify(payload),
          headers: headers(sessions[0], campaign.managerKey),
          method: "PATCH",
        },
        bindings,
      );
      expect(response.status).toBe(200);
    }
    const denied = await app.request(
      `/api/campaigns/${campaign.id}/manage`,
      {
        body: JSON.stringify({ notice: "変更" }),
        headers: headers(sessions[0], "0".repeat(64)),
        method: "PATCH",
      },
      bindings,
    );
    expect(denied.status).toBe(403);
  });

  it("protects spreadsheet formulas and keeps exports manager-only", async () => {
    const campaign = await createCampaign();
    await joinCampaign(campaign.id, 1, { displayName: "=SUM(A1:A2)" });
    const denied = await app.request(
      `/api/campaigns/${campaign.id}/roster.csv`,
      { headers: headers() },
      bindings,
    );
    expect(denied.status).toBe(403);
    const allowed = await app.request(
      `/api/campaigns/${campaign.id}/roster.csv`,
      { headers: headers(sessions[0], campaign.managerKey) },
      bindings,
    );
    const csv = await allowed.text();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-disposition")).toContain("shisou-");
    expect(csv).toContain("'=SUM(A1:A2)");
    const json = await app.request(
      `/api/campaigns/${campaign.id}/roster.json`,
      { headers: headers(sessions[0], campaign.managerKey) },
      bindings,
    );
    expect(json.status).toBe(200);
  });

  it("hides a campaign after three distinct safety reports", async () => {
    const campaign = await createCampaign();
    for (let index = 1; index <= 3; index += 1) {
      const response = await app.request(
        `/api/campaigns/${campaign.id}/report`,
        {
          body: JSON.stringify({ reason: "unsafe" }),
          headers: headers(sessions[index]),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(202);
    }
    expect((await app.request(`/api/campaigns/${campaign.id}`, undefined, bindings)).status).toBe(
      404,
    );
  });

  it("rejects unknown telemetry and keeps QA events separate", async () => {
    const unknown = await app.request(
      "/api/telemetry",
      {
        body: JSON.stringify({ name: "email_captured" }),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(unknown.status).toBe(400);
    await createCampaign({}, sessions[0], true);
    const rows = await bindings.DB.prepare(
      "SELECT is_qa, COUNT(*) AS count FROM product_events GROUP BY is_qa ORDER BY is_qa",
    ).all<{ count: number; is_qa: number }>();
    expect(rows.results).toEqual([{ count: 1, is_qa: 1 }]);
  });

  it("removes expired campaigns and old telemetry on schedule", async () => {
    const campaign = await createCampaign();
    await bindings.DB.prepare("UPDATE campaigns SET expires_at = 1 WHERE id = ?")
      .bind(campaign.id)
      .run();
    await bindings.DB.prepare("UPDATE product_events SET created_at = 1").run();
    await scheduled({} as ScheduledEvent, bindings, {} as ExecutionContext);
    expect(
      await bindings.DB.prepare("SELECT id FROM campaigns WHERE id = ?").bind(campaign.id).first(),
    ).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM product_events").first()).toBeNull();
  });

  it("keeps the static release surface code-safe and visually product-specific", async () => {
    const [appScript, campaignScript, styles, wrangler, og] = await Promise.all([
      readFile(appScriptPath, "utf8"),
      readFile(campaignScriptPath, "utf8"),
      readFile(stylesPath, "utf8"),
      readFile(wranglerPath, "utf8"),
      stat(ogPath),
    ]);
    expect(appScript + campaignScript).not.toMatch(/innerHTML|eval\(|new Function/u);
    expect(styles).not.toMatch(/gradient/iu);
    expect(wrangler).not.toContain("TO_BE_CREATED");
    expect(og.size).toBeGreaterThan(2500);
  });
});
