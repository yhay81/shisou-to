import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

import {
  completedTestDays,
  isCheckinDay,
  isOfficialGroupUrl,
  isOfficialPlayTestUrl,
  relativeTestDay,
  type AndroidVersion,
  type DeviceKind,
} from "./domain/testing";

export type Bindings = {
  ASSETS: Fetcher;
  DB: D1Database;
};

type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type CampaignStatus = "closed" | "completed" | "hidden" | "recruiting" | "running";
type TesterStatus = "completed" | "joined" | "testing" | "withdrawn";

type CampaignRow = {
  app_name: string;
  created_at: number;
  creator_session_id: string;
  expires_at: number;
  genre: string;
  group_url: string;
  id: string;
  manager_token_hash: string;
  notice: string;
  play_url: string;
  public_listing: number;
  status: CampaignStatus;
  summary: string;
  target_count: number;
  test_focus: string;
  updated_at: number;
};

type TesterRow = {
  android_version: AndroidVersion;
  campaign_id: string;
  created_at: number;
  device_kind: DeviceKind;
  display_name: string;
  display_name_key: string;
  id: string;
  opted_in_on: string;
  session_id: string;
  status: TesterStatus;
  token_hash: string;
  updated_at: number;
};

type CheckinRow = {
  created_at: number;
  day_index: number;
  id: number;
  note: string;
  result: "blocked" | "used";
  tester_id: string;
};

type FeedbackRow = {
  body: string;
  category: string;
  created_at: number;
  display_name: string;
  id: number;
};

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 429,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const canonicalOrigin = "https://shisou-to.yhay81.com";
const idPattern = /^[0-9a-f]{32}$/u;
const tokenPattern = /^[0-9a-f]{64}$/u;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu;
const phonePattern = /(?:\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/u;
const linkPattern = /(?:https?:\/\/|www\.)/iu;
const genres = new Set(["game", "learning", "lifestyle", "other", "productivity", "tools"]);
const androidVersions = new Set(["12", "13", "14", "15", "16", "other"]);
const deviceKinds = new Set(["chromebook", "other", "phone", "tablet"]);
const feedbackCategories = new Set(["bug", "idea", "other", "usability"]);
const reportReasons = new Set(["other", "spam", "unsafe"]);
export const telemetryNames = new Set([
  "visited",
  "campaign_created",
  "tester_joined",
  "optin_confirmed",
  "day_checked",
  "feedback_sent",
  "roster_exported",
  "public_campaign_viewed",
  "official_link_opened",
  "returned",
]);

const statusLabels: Record<CampaignStatus, string> = {
  closed: "募集終了",
  completed: "試走完了",
  hidden: "非表示",
  recruiting: "募集中",
  running: "試走中",
};

const genreLabels: Record<string, string> = {
  game: "ゲーム",
  learning: "学習",
  lifestyle: "暮らし",
  other: "その他",
  productivity: "仕事・効率化",
  tools: "ツール",
};

const deviceLabels: Record<DeviceKind, string> = {
  chromebook: "Chromebook",
  other: "その他",
  phone: "スマートフォン",
  tablet: "タブレット",
};

const feedbackLabels: Record<string, string> = {
  bug: "不具合",
  idea: "提案",
  other: "その他",
  usability: "使いにくさ",
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jstDay = (milliseconds = Date.now()) =>
  new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const randomHex = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) throw new ApiError("cross_site_request", 403);
};

const parseJson = async (c: AppContext, maximumBytes = 4096) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > maximumBytes) throw new ApiError("payload_too_large", 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};

const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};

const cleanText = (
  payload: Record<string, unknown>,
  key: string,
  maximum: number,
  options: { allowEmpty?: boolean; blockContact?: boolean } = {},
) => {
  if (typeof payload[key] !== "string") throw new ApiError("invalid_" + key, 400);
  const value = payload[key].replace(/\r\n?/gu, "\n").trim();
  if ((!options.allowEmpty && value.length === 0) || value.length > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 32 && point !== 9 && point !== 10) || point === 127) {
      throw new ApiError("invalid_" + key, 400);
    }
  }
  if (
    options.blockContact &&
    (emailPattern.test(value) || phonePattern.test(value) || linkPattern.test(value))
  ) {
    throw new ApiError("contact_not_allowed_in_" + key, 400);
  }
  return value;
};

const enumText = (payload: Record<string, unknown>, key: string, values: Set<string>) => {
  const value = cleanText(payload, key, 32);
  if (!values.has(value)) throw new ApiError("invalid_" + key, 400);
  return value;
};

const integerValue = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
) => {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  return value as number;
};

const booleanValue = (payload: Record<string, unknown>, key: string) => {
  if (typeof payload[key] !== "boolean") throw new ApiError("invalid_" + key, 400);
  return payload[key] as boolean;
};

const validateId = (value: string) => {
  if (!idPattern.test(value)) throw new ApiError("not_found", 404);
  return value;
};

const sessionId = (c: AppContext) => {
  const value = c.req.header("x-shisou-session") ?? "";
  if (!sessionPattern.test(value)) throw new ApiError("invalid_session", 400);
  return value.toLowerCase();
};

const capability = (c: AppContext) => {
  const value = c.req.header("x-shisou-key") ?? "";
  if (!tokenPattern.test(value)) throw new ApiError("invalid_capability", 403);
  return value;
};

const campaignById = async (database: D1Database, id: string) => {
  const row = await database
    .prepare("SELECT * FROM campaigns WHERE id = ? AND expires_at > ?")
    .bind(id, nowSeconds())
    .first<CampaignRow>();
  if (!row || row.status === "hidden") throw new ApiError("not_found", 404);
  return row;
};

const managerCampaign = async (c: AppContext, id: string) => {
  const campaign = await campaignById(c.env.DB, id);
  const suppliedHash = await sha256(capability(c));
  if (!constantTimeEqual(campaign.manager_token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return campaign;
};

const ownedTester = async (c: AppContext, campaignId: string) => {
  const suppliedHash = await sha256(capability(c));
  const row = await c.env.DB.prepare(
    "SELECT * FROM testers WHERE campaign_id = ? AND token_hash = ?",
  )
    .bind(campaignId, suppliedHash)
    .first<TesterRow>();
  if (!row || !constantTimeEqual(row.token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return row;
};

const recordEvent = async (
  c: AppContext,
  name: string,
  campaignId: string,
  actorSession?: string,
) => {
  if (!telemetryNames.has(name)) return;
  const actor = actorSession ?? sessionId(c);
  const qa = c.req.header("x-shisou-qa") === "1" ? 1 : 0;
  await c.env.DB.prepare(
    "INSERT INTO product_events (name,session_id,campaign_id,day,created_at,is_qa) VALUES (?,?,?,?,?,?)",
  )
    .bind(name, actor, campaignId, jstDay(), nowSeconds(), qa)
    .run();
};

const getTesters = async (database: D1Database, campaignId: string) => {
  const result = await database
    .prepare("SELECT * FROM testers WHERE campaign_id = ? ORDER BY created_at, id")
    .bind(campaignId)
    .all<TesterRow>();
  return result.results;
};

const getCheckins = async (database: D1Database, campaignId: string) => {
  const result = await database
    .prepare(
      "SELECT id,tester_id,day_index,result,note,created_at FROM checkins WHERE campaign_id = ? ORDER BY tester_id, day_index",
    )
    .bind(campaignId)
    .all<CheckinRow>();
  return result.results;
};

const campaignCounts = (testers: TesterRow[]) => ({
  completed: testers.filter((tester) => tester.status === "completed").length,
  joined: testers.filter((tester) => tester.status === "joined").length,
  testing: testers.filter((tester) => tester.status === "testing").length,
  total: testers.filter((tester) => tester.status !== "withdrawn").length,
  withdrawn: testers.filter((tester) => tester.status === "withdrawn").length,
});

const publicState = async (database: D1Database, campaign: CampaignRow) => {
  const testers = await getTesters(database, campaign.id);
  return {
    campaign: {
      appName: campaign.app_name,
      genre: campaign.genre,
      genreLabel: genreLabels[campaign.genre] ?? "その他",
      groupUrl: campaign.group_url,
      id: campaign.id,
      notice: campaign.notice,
      playUrl: campaign.play_url,
      publicListing: campaign.public_listing === 1,
      status: campaign.status,
      statusLabel: statusLabels[campaign.status],
      summary: campaign.summary,
      targetCount: campaign.target_count,
      testFocus: campaign.test_focus,
    },
    counts: campaignCounts(testers),
  };
};

const managerState = async (database: D1Database, campaign: CampaignRow) => {
  const state = await publicState(database, campaign);
  const testers = await getTesters(database, campaign.id);
  const checkins = await getCheckins(database, campaign.id);
  const feedback = await database
    .prepare(
      "SELECT f.id,f.category,f.body,f.created_at,t.display_name FROM feedback f JOIN testers t ON t.id = f.tester_id WHERE f.campaign_id = ? ORDER BY f.created_at DESC LIMIT 200",
    )
    .bind(campaign.id)
    .all<FeedbackRow>();
  return {
    ...state,
    feedback: feedback.results.map((item) => ({
      body: item.body,
      category: item.category,
      categoryLabel: feedbackLabels[item.category] ?? "その他",
      createdAt: item.created_at,
      displayName: item.display_name,
      id: item.id,
    })),
    manager: true,
    testers: testers.map((tester) => {
      const ownCheckins = checkins.filter((item) => item.tester_id === tester.id);
      return {
        androidVersion: tester.android_version,
        completedDays: completedTestDays(ownCheckins.map((item) => item.day_index)),
        createdAt: tester.created_at,
        deviceKind: tester.device_kind,
        deviceLabel: deviceLabels[tester.device_kind],
        displayName: tester.display_name,
        id: tester.id,
        optedInOn: tester.opted_in_on,
        status: tester.status,
      };
    }),
  };
};

const testerState = async (database: D1Database, campaign: CampaignRow, tester: TesterRow) => {
  const state = await publicState(database, campaign);
  const result = await database
    .prepare(
      "SELECT id,tester_id,day_index,result,note,created_at FROM checkins WHERE tester_id = ? ORDER BY day_index",
    )
    .bind(tester.id)
    .all<CheckinRow>();
  const day = tester.opted_in_on ? relativeTestDay(tester.opted_in_on, jstDay()) : 0;
  return {
    ...state,
    tester: {
      androidVersion: tester.android_version,
      checkins: result.results.map((item) => ({
        createdAt: item.created_at,
        dayIndex: item.day_index,
        note: item.note,
        result: item.result,
      })),
      completedDays: completedTestDays(result.results.map((item) => item.day_index)),
      currentDay: day,
      deviceKind: tester.device_kind,
      displayName: tester.display_name,
      optedInOn: tester.opted_in_on,
      status: tester.status,
    },
  };
};

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  script,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  script?: string;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      <link href={canonical} rel="canonical" />
      <meta content={noindex ? "noindex,nofollow" : "index,follow"} name="robots" />
      <meta content="website" property="og:type" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content={canonicalOrigin + "/og.svg"} property="og:image" />
      <meta content="#172536" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      {script ? <script defer src={script}></script> : null}
    </head>
    <body>
      <a class="skip-link" href="#main">
        本文へ移動
      </a>
      <header class="site-header">
        <a aria-label="試走灯 ホーム" class="brand" href="/">
          <span aria-hidden="true" class="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>試走灯</span>
        </a>
        <nav aria-label="主要メニュー">
          <a href="/requirements">12人・14日の要件</a>
          <a href="/guide">使い方</a>
          <a href="/privacy">データ</a>
        </nav>
      </header>
      {children}
      <footer>
        <span>© 2026 yhay81</span>
        <a href="/privacy">プライバシー</a>
        <a href="https://github.com/yhay81/shisou-to">GitHub</a>
      </footer>
    </body>
  </html>
);

const RunwayPreview = () => (
  <div aria-label="12台の端末と14日分の点灯路" class="runway-preview" role="img">
    <div class="device-rack">
      {Array.from({ length: 12 }, (_, index) => (
        <i class={index < 8 ? "lit" : ""} />
      ))}
    </div>
    <div class="control-gate">
      <span>12</span>
      <b>TESTERS</b>
    </div>
    <div class="runway-line">
      {Array.from({ length: 14 }, (_, index) => (
        <i class={index < 6 ? "lit" : ""} />
      ))}
    </div>
    <div class="day-sign">
      <strong>DAY 06</strong>
      <span>/ 14</span>
    </div>
  </div>
);

type ListedCampaign = CampaignRow & { tester_count: number };

const CampaignCard = ({ campaign }: { campaign: ListedCampaign }) => (
  <a class="campaign-card" href={`/c/${campaign.id}`}>
    <div class="campaign-card-top">
      <span class="genre-chip">{genreLabels[campaign.genre] ?? "その他"}</span>
      <span class={`status-chip ${campaign.status}`}>{statusLabels[campaign.status]}</span>
    </div>
    <h3>{campaign.app_name}</h3>
    <p>{campaign.summary}</p>
    <div class="tester-meter">
      {Array.from({ length: campaign.target_count }, (_, index) => (
        <i class={index < campaign.tester_count ? "lit" : ""} />
      ))}
    </div>
    <div class="campaign-count">
      <b>{campaign.tester_count}</b>
      <span>/ {campaign.target_count}人</span>
    </div>
  </a>
);

const Home = ({ campaigns }: { campaigns: ListedCampaign[] }) => (
  <Layout
    canonical={canonicalOrigin + "/"}
    description="Androidアプリのクローズドテスト募集、参加確認、14日間の自己申告チェック、フィードバックを一つの点灯盤で進めます。"
    script="/app.js"
    title="試走灯｜Androidクローズドテストの進行盤"
  >
    <main id="main">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">ANDROID CLOSED TEST RUNWAY</p>
          <h1>12台の端末。14日の試走。</h1>
          <p class="hero-lead">公式リンクの外でメールを集めず、参加・日次確認・気づきを一列に。</p>
          <button class="primary" data-open-create type="button">
            テスト募集を開く
          </button>
        </div>
        <RunwayPreview />
      </section>

      <section class="flight-strip" aria-label="試走の流れ">
        <article>
          <span class="strip-icon devices-icon" />
          <b>募集</b>
          <small>公式リンクだけ</small>
        </article>
        <i>→</i>
        <article>
          <span class="strip-icon check-icon" />
          <b>点灯</b>
          <small>各自の14日</small>
        </article>
        <i>→</i>
        <article>
          <span class="strip-icon feedback-icon" />
          <b>整備</b>
          <small>不具合と提案</small>
        </article>
      </section>

      <section class="create-panel" id="create-panel">
        <div class="panel-heading">
          <span class="panel-number">01</span>
          <div>
            <p class="eyebrow">OPEN A TEST RUN</p>
            <h2>募集盤を準備する</h2>
          </div>
        </div>
        <form data-create-form>
          <div class="form-grid">
            <label class="field field-wide">
              アプリ名
              <input maxlength={60} name="appName" required />
            </label>
            <label class="field">
              種類
              <select name="genre" required>
                <option value="game">ゲーム</option>
                <option value="learning">学習</option>
                <option value="lifestyle">暮らし</option>
                <option value="productivity">仕事・効率化</option>
                <option value="tools">ツール</option>
                <option value="other">その他</option>
              </select>
            </label>
            <label class="field">
              目標人数
              <input max="30" min="12" name="targetCount" required type="number" value="12" />
            </label>
            <label class="field field-wide">
              アプリの説明
              <textarea maxlength={300} name="summary" required rows={3} />
            </label>
            <label class="field field-wide">
              見てほしいところ
              <textarea maxlength={200} name="testFocus" rows={2} />
            </label>
            <label class="field field-wide">
              Google Groups のグループURL
              <input
                inputmode="url"
                name="groupUrl"
                placeholder="https://groups.google.com/g/..."
                required
                type="url"
              />
            </label>
            <label class="field field-wide">
              Google Play のテスト参加URL
              <input
                inputmode="url"
                name="playUrl"
                placeholder="https://play.google.com/apps/testing/..."
                required
                type="url"
              />
            </label>
            <label class="check-field field-wide">
              <input checked name="publicListing" type="checkbox" />
              <span>募集中一覧に表示する</span>
            </label>
            <label aria-hidden="true" class="honeypot">
              Webサイト
              <input autocomplete="off" name="website" tabindex={-1} />
            </label>
          </div>
          <div class="official-boundary">
            <span>Google公式</span>
            <p>
              グループ参加とPlayテスト参加はGoogle上で行います。試走灯はメールアドレスを受け取りません。
            </p>
          </div>
          <button class="primary" type="submit">
            募集盤を開く
          </button>
          <p aria-live="polite" class="form-message" data-form-message />
        </form>
      </section>

      <section class="listing-section">
        <div class="section-heading">
          <p class="eyebrow">OPEN RUNS</p>
          <h2>いま募集中の試走</h2>
          <span>{campaigns.length}件</span>
        </div>
        <div class="campaign-grid">
          {campaigns.length ? (
            campaigns.map((campaign) => <CampaignCard campaign={campaign} />)
          ) : (
            <div class="empty-hangar">
              <span />
              <p>募集中の試走はまだありません。</p>
            </div>
          )}
        </div>
      </section>

      <section class="boundary-row">
        <article>
          <b>＠</b>
          <div>
            <h3>メールを集めない</h3>
            <p>GoogleアカウントはGoogle側だけで扱います。</p>
          </div>
        </article>
        <article>
          <b>¥</b>
          <div>
            <h3>報酬・決済なし</h3>
            <p>相互テストや承認結果を約束しません。</p>
          </div>
        </article>
        <article>
          <b>45</b>
          <div>
            <h3>自動で期限切れ</h3>
            <p>募集と記録は45日で削除します。</p>
          </div>
        </article>
      </section>
    </main>
  </Layout>
);

const CampaignShell = ({ id, mode }: { id: string; mode: "campaign" | "manage" | "tester" }) => (
  <Layout
    canonical={canonicalOrigin + `/c/${id}`}
    description="Androidアプリのクローズドテスト参加と14日間の自己申告チェックを進めます。"
    noindex
    script="/campaign.js"
    title="試走盤｜試走灯"
  >
    <main class="campaign-shell" data-campaign-id={id} data-mode={mode} id="main">
      <section class="loading-bay" data-loading>
        <span class="loader-lights" />
        <p>試走盤を点検中…</p>
      </section>
      <div data-campaign-app hidden>
        <section class="campaign-head">
          <div class="app-beacon">
            <i />
            <i />
            <i />
            <span data-status>募集中</span>
          </div>
          <div class="campaign-title-block">
            <p class="eyebrow">CLOSED TEST CONTROL</p>
            <h1 data-app-name />
            <div class="campaign-meta">
              <span data-genre />
              <span>
                <b data-tester-count>0</b> / <i data-target-count>12</i>人
              </span>
            </div>
          </div>
        </section>

        <section class="capacity-console">
          <div class="device-wall" data-device-wall>
            {Array.from({ length: 12 }, () => (
              <i />
            ))}
          </div>
          <div class="capacity-readout">
            <small>TESTERS</small>
            <strong data-capacity-readout>0 / 12</strong>
          </div>
        </section>

        <section class="notice-panel" data-notice-panel hidden>
          <span />
          <p data-notice />
        </section>

        <div class="campaign-layout">
          <section class="briefing-board">
            <div class="panel-heading">
              <span class="panel-number">01</span>
              <div>
                <p class="eyebrow">BRIEFING</p>
                <h2>試走内容</h2>
              </div>
            </div>
            <p class="campaign-summary" data-summary />
            <div class="focus-card">
              <small>見てほしいところ</small>
              <p data-test-focus />
            </div>
            <div class="official-links">
              <a
                class="official-button groups-button"
                data-group-link
                href="#"
                rel="noopener noreferrer"
                target="_blank"
              >
                <span>G</span>Google Groupsへ参加
              </a>
              <a
                class="official-button play-button"
                data-play-link
                href="#"
                rel="noopener noreferrer"
                target="_blank"
              >
                <span>▶</span>Google Playテストへ
              </a>
            </div>
            <p class="external-note">
              Google上で参加後、この盤へ戻って点灯してください。試走灯はGoogleの判定や製品版アクセスを保証しません。
            </p>
          </section>

          <section class="join-desk" data-join-desk>
            <div class="panel-heading">
              <span class="panel-number">02</span>
              <div>
                <p class="eyebrow">JOIN THE RUN</p>
                <h2>テスターとして参加</h2>
              </div>
            </div>
            <form data-join-form>
              <label class="field">
                表示名
                <input maxlength={24} name="displayName" required />
              </label>
              <div class="two-fields">
                <label class="field">
                  Android
                  <select name="androidVersion">
                    <option value="16">16</option>
                    <option selected value="15">
                      15
                    </option>
                    <option value="14">14</option>
                    <option value="13">13</option>
                    <option value="12">12</option>
                    <option value="other">その他</option>
                  </select>
                </label>
                <label class="field">
                  端末
                  <select name="deviceKind">
                    <option value="phone">スマートフォン</option>
                    <option value="tablet">タブレット</option>
                    <option value="chromebook">Chromebook</option>
                    <option value="other">その他</option>
                  </select>
                </label>
              </div>
              <label aria-hidden="true" class="honeypot">
                Webサイト
                <input autocomplete="off" name="website" tabindex={-1} />
              </label>
              <button class="primary full-button" type="submit">
                参加札を受け取る
              </button>
              <p aria-live="polite" class="form-message" data-join-message />
            </form>
          </section>
        </div>

        <section class="tester-console" data-tester-console hidden>
          <div class="panel-heading">
            <span class="panel-number">02</span>
            <div>
              <p class="eyebrow">MY TEST RUN</p>
              <h2>
                <span data-tester-name />
                の14日
              </h2>
            </div>
          </div>
          <div class="runway-days" data-runway-days>
            {Array.from({ length: 14 }, (_, index) => (
              <i data-day={index + 1}>
                <b>{index + 1}</b>
                <span />
              </i>
            ))}
          </div>
          <div class="tester-status">
            <span>現在</span>
            <strong data-current-day>参加前</strong>
            <small data-completed-days>0 / 14 点灯</small>
          </div>
          <button class="primary" data-confirm-optin type="button">
            Googleで参加したので試走を始める
          </button>
          <form class="checkin-form" data-checkin-form hidden>
            <fieldset>
              <legend>今日の確認</legend>
              <label>
                <input checked name="result" type="radio" value="used" />
                <span>使えた</span>
              </label>
              <label>
                <input name="result" type="radio" value="blocked" />
                <span>止まった</span>
              </label>
            </fieldset>
            <label class="field">
              短いメモ
              <textarea maxlength={160} name="note" rows={2} />
            </label>
            <button class="primary" type="submit">
              今日を点灯する
            </button>
            <p aria-live="polite" class="form-message" data-checkin-message />
          </form>
          <form class="feedback-form" data-feedback-form>
            <div class="feedback-form-head">
              <h3>気づきを送る</h3>
              <select name="category">
                <option value="bug">不具合</option>
                <option value="usability">使いにくさ</option>
                <option value="idea">提案</option>
                <option value="other">その他</option>
              </select>
            </div>
            <label class="field">
              <textarea
                maxlength={300}
                name="body"
                placeholder="起きたこと、操作、期待した動き"
                required
                rows={3}
              />
            </label>
            <button class="secondary" type="submit">
              開発者へ送る
            </button>
            <p aria-live="polite" class="form-message" data-feedback-message />
          </form>
          <button class="text-button" data-withdraw type="button">
            参加を取り消す
          </button>
        </section>

        <section class="manager-console" data-manager-console hidden>
          <div class="panel-heading">
            <span class="panel-number">03</span>
            <div>
              <p class="eyebrow">DEVELOPER CONTROL</p>
              <h2>進行と気づき</h2>
            </div>
          </div>
          <div class="manager-actions">
            <button class="secondary" data-copy-public type="button">
              募集URLをコピー
            </button>
            <button class="secondary" data-toggle-listing type="button">
              一覧から隠す
            </button>
            <button class="secondary" data-close-campaign type="button">
              募集を閉じる
            </button>
            <a class="button-link" data-export-csv href="#">
              CSV
            </a>
            <a class="button-link" data-export-json href="#">
              JSON
            </a>
          </div>
          <form class="notice-form" data-notice-form>
            <label class="field">
              テスターへのお知らせ
              <textarea maxlength={240} name="notice" rows={2} />
            </label>
            <button class="secondary" type="submit">
              お知らせを更新
            </button>
          </form>
          <div class="progress-grid" data-progress-grid />
          <div class="feedback-board">
            <h3>届いた気づき</h3>
            <div data-feedback-list />
          </div>
          <p class="capability-note">このURLの #key は開発者だけで保管してください。</p>
        </section>

        <section class="share-strip">
          <button class="text-button" data-share type="button">
            募集URLを共有
          </button>
          <span>・</span>
          <button class="text-button" data-report type="button">
            問題を報告
          </button>
        </section>
      </div>
      <section class="campaign-error" data-error hidden>
        <span class="dark-beacon" />
        <h1>試走盤を開けません。</h1>
        <p data-error-message />
        <a class="button-link" href="/">
          ホームへ
        </a>
      </section>
    </main>
  </Layout>
);

const Guide = () => (
  <Layout
    canonical={canonicalOrigin + "/guide"}
    description="試走灯でAndroidクローズドテストの募集と14日間の確認を進める手順。"
    title="使い方｜試走灯"
  >
    <main class="info-page" id="main">
      <div class="info-heading">
        <RunwayPreview />
        <div>
          <p class="eyebrow">RUN PROCEDURE</p>
          <h1>公式の外側を、点灯盤で整える。</h1>
        </div>
      </div>
      <ol class="guide-cards">
        <li>
          <b>1</b>
          <div>
            <h2>公式リンクを準備</h2>
            <p>Google GroupsのグループURLとGoogle Playのテスト参加URLを用意します。</p>
          </div>
        </li>
        <li>
          <b>2</b>
          <div>
            <h2>募集盤を共有</h2>
            <p>
              公開一覧または専用URLから参加者を募ります。メールアドレスはGoogle側だけで扱います。
            </p>
          </div>
        </li>
        <li>
          <b>3</b>
          <div>
            <h2>各自の14日を点灯</h2>
            <p>参加者がGoogleで参加した日を起点に、利用結果を1日1回自己申告します。</p>
          </div>
        </li>
        <li>
          <b>4</b>
          <div>
            <h2>気づきを直す</h2>
            <p>不具合、使いにくさ、提案を開発者盤へ集め、製品版申請前に改善します。</p>
          </div>
        </li>
      </ol>
      <section class="rule-card">
        <h2>この盤がしないこと</h2>
        <p>
          Google Play
          Consoleの状態は読み取りません。参加日数は自己申告で、Googleの製品版アクセス、審査通過、アプリ品質を保証しません。
        </p>
      </section>
    </main>
  </Layout>
);

const Requirements = () => (
  <Layout
    canonical={canonicalOrigin + "/requirements"}
    description="Google Play公式のクローズドテスト要件と、試走灯で扱う範囲。"
    title="12人・14日の要件｜試走灯"
  >
    <main class="info-page requirements-page" id="main">
      <div class="requirement-visual">
        <div class="twelve-grid">
          {Array.from({ length: 12 }, () => (
            <i />
          ))}
        </div>
        <span>×</span>
        <div class="fourteen-rail">
          {Array.from({ length: 14 }, () => (
            <i />
          ))}
        </div>
      </div>
      <div class="info-heading compact-heading">
        <div>
          <p class="eyebrow">OFFICIAL REQUIREMENT</p>
          <h1>12人が、14日間連続で参加。</h1>
        </div>
      </div>
      <p class="info-lead">
        Google
        Play公式ヘルプは、2023年11月13日より後に作成された個人デベロッパーアカウントについて、最低12人が14日間連続で参加したクローズドテストを製品版アクセス申請の条件としています。
      </p>
      <div class="source-cards">
        <a
          href="https://support.google.com/googleplay/android-developer/answer/14151465?hl=ja"
          rel="noopener noreferrer"
          target="_blank"
        >
          <b>Google Play Console ヘルプ</b>
          <span>新しい個人アカウントのテスト要件 ↗</span>
        </a>
        <a
          href="https://support.google.com/googleplay/android-developer/answer/9845334?hl=ja"
          rel="noopener noreferrer"
          target="_blank"
        >
          <b>Google Play Console ヘルプ</b>
          <span>テストトラックの設定 ↗</span>
        </a>
      </div>
      <section class="rule-card warning-rule">
        <h2>最終確認は必ずPlay Consoleで</h2>
        <p>
          要件と審査判断はGoogleが変更・運用します。試走灯の点灯数は証明書ではなく、開発者とテスターの進行確認です。
        </p>
      </section>
    </main>
  </Layout>
);

const Privacy = () => (
  <Layout
    canonical={canonicalOrigin + "/privacy"}
    description="試走灯が保存するデータと保存しないデータ、45日の保持期限。"
    title="データ境界｜試走灯"
  >
    <main class="info-page" id="main">
      <div class="info-heading privacy-heading">
        <span class="shield-device">
          <i />
        </span>
        <div>
          <p class="eyebrow">DATA BOUNDARY</p>
          <h1>メールはGoogleに。進行だけをこの盤に。</h1>
        </div>
      </div>
      <div class="data-grid">
        <section class="data-card keep">
          <h2>保存する</h2>
          <ul>
            <li>アプリ名、種類、説明、テスト観点</li>
            <li>Google Groups / Playの公式URL</li>
            <li>表示名、端末種別、Android版</li>
            <li>参加日、日次の自己申告、短いメモ</li>
            <li>不具合・使いにくさ・提案</li>
          </ul>
        </section>
        <section class="data-card never">
          <h2>保存しない</h2>
          <ul>
            <li>メールアドレス、電話番号、住所</li>
            <li>GoogleアカウントやPlay Console認証</li>
            <li>APK / AAB、ソースコード、端末識別子</li>
            <li>報酬、決済、本人確認情報</li>
            <li>Googleの審査結果や非公開Console情報</li>
          </ul>
        </section>
      </div>
      <p class="retention-note">
        募集、参加、点灯、気づきは作成45日後に削除します。編集鍵そのものは保存せず、SHA-256ハッシュだけを照合します。
      </p>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT c.*,COUNT(CASE WHEN t.status != 'withdrawn' THEN 1 END) AS tester_count FROM campaigns c LEFT JOIN testers t ON t.campaign_id = c.id WHERE c.public_listing = 1 AND c.status IN ('recruiting','running') AND c.expires_at > ? GROUP BY c.id ORDER BY c.created_at DESC LIMIT 24",
  )
    .bind(nowSeconds())
    .all<ListedCampaign>();
  c.header("Cache-Control", "no-store");
  return c.html(<Home campaigns={result.results} />);
});
app.get("/guide", (c) => c.html(<Guide />));
app.get("/requirements", (c) => c.html(<Requirements />));
app.get("/privacy", (c) => c.html(<Privacy />));
app.get("/c/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await campaignById(c.env.DB, id);
  return c.html(<CampaignShell id={id} mode="campaign" />);
});
app.get("/m/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await campaignById(c.env.DB, id);
  return c.html(<CampaignShell id={id} mode="manage" />);
});
app.get("/t/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await campaignById(c.env.DB, id);
  return c.html(<CampaignShell id={id} mode="tester" />);
});

app.get("/sitemap.xml", (c) => {
  c.header("Content-Type", "application/xml; charset=UTF-8");
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  const paths = ["/", "/guide", "/requirements", "/privacy"];
  return c.body(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      paths.map((path) => "  <url><loc>" + canonicalOrigin + path + "</loc></url>").join("\n") +
      "\n</urlset>",
  );
});

app.post("/api/telemetry", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c, 512));
  const name = cleanText(payload, "name", 40);
  if (!telemetryNames.has(name)) throw new ApiError("invalid_event", 400);
  const campaignId =
    typeof payload.campaignId === "string" && idPattern.test(payload.campaignId)
      ? payload.campaignId
      : "";
  await recordEvent(c, name, campaignId);
  return c.json({ ok: true }, 202);
});

app.post("/api/campaigns", async (c) => {
  enforceSameOrigin(c);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const appName = cleanText(payload, "appName", 60, { blockContact: true });
  const genre = enumText(payload, "genre", genres);
  const summary = cleanText(payload, "summary", 300, { blockContact: true });
  const testFocus = cleanText(payload, "testFocus", 200, { allowEmpty: true, blockContact: true });
  const groupUrl = cleanText(payload, "groupUrl", 300);
  const playUrl = cleanText(payload, "playUrl", 300);
  if (!isOfficialGroupUrl(groupUrl)) throw new ApiError("invalid_groupUrl", 400);
  if (!isOfficialPlayTestUrl(playUrl)) throw new ApiError("invalid_playUrl", 400);
  const targetCount = integerValue(payload, "targetCount", 12, 30);
  const publicListing = booleanValue(payload, "publicListing");
  const current = nowSeconds();
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM campaigns WHERE creator_session_id = ? AND created_at > ?",
  )
    .bind(actor, current - 86400)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) throw new ApiError("create_rate_limited", 429);
  const id = randomHex(16);
  const token = randomHex(32);
  await c.env.DB.prepare(
    "INSERT INTO campaigns (id,manager_token_hash,creator_session_id,app_name,genre,summary,test_focus,group_url,play_url,target_count,public_listing,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      await sha256(token),
      actor,
      appName,
      genre,
      summary,
      testFocus,
      groupUrl,
      playUrl,
      targetCount,
      publicListing ? 1 : 0,
      current,
      current,
      current + 45 * 86400,
    )
    .run();
  await recordEvent(c, "campaign_created", id, actor);
  return c.json({ id, manageUrl: "/m/" + id + "#key=" + token, publicUrl: "/c/" + id }, 201);
});

app.get("/api/campaigns/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  return c.json(await publicState(c.env.DB, await campaignById(c.env.DB, id)));
});

app.get("/api/campaigns/:id/manage", async (c) => {
  const id = validateId(c.req.param("id"));
  return c.json(await managerState(c.env.DB, await managerCampaign(c, id)));
});

app.get("/api/campaigns/:id/tester", async (c) => {
  const id = validateId(c.req.param("id"));
  const campaign = await campaignById(c.env.DB, id);
  return c.json(await testerState(c.env.DB, campaign, await ownedTester(c, id)));
});

app.post("/api/campaigns/:id/join", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const campaign = await campaignById(c.env.DB, id);
  if (!new Set(["recruiting", "running"]).has(campaign.status))
    throw new ApiError("recruitment_closed", 409);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c, 1536));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const displayName = cleanText(payload, "displayName", 24, { blockContact: true });
  const displayNameKey = displayName.normalize("NFKC").toLocaleLowerCase("ja");
  const androidVersion = enumText(payload, "androidVersion", androidVersions) as AndroidVersion;
  const deviceKind = enumText(payload, "deviceKind", deviceKinds) as DeviceKind;
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM testers WHERE campaign_id = ? AND status != 'withdrawn'",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 40) throw new ApiError("tester_limit_reached", 409);
  const token = randomHex(32);
  const testerId = randomHex(16);
  const current = nowSeconds();
  try {
    await c.env.DB.prepare(
      "INSERT INTO testers (id,campaign_id,session_id,token_hash,display_name,display_name_key,android_version,device_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        testerId,
        id,
        actor,
        await sha256(token),
        displayName,
        displayNameKey,
        androidVersion,
        deviceKind,
        current,
        current,
      )
      .run();
  } catch {
    throw new ApiError("already_joined_or_name_taken", 409);
  }
  await recordEvent(c, "tester_joined", id, actor);
  return c.json({ id: testerId, testerUrl: "/t/" + id + "#key=" + token }, 201);
});

app.post("/api/campaigns/:id/opt-in", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const campaign = await campaignById(c.env.DB, id);
  if (!new Set(["recruiting", "running"]).has(campaign.status))
    throw new ApiError("recruitment_closed", 409);
  const tester = await ownedTester(c, id);
  if (tester.status === "withdrawn") throw new ApiError("tester_withdrawn", 409);
  if (tester.opted_in_on) return c.json({ optedInOn: tester.opted_in_on });
  const today = jstDay();
  const current = nowSeconds();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE testers SET status = 'testing',opted_in_on = ?,updated_at = ? WHERE id = ?",
    ).bind(today, current, tester.id),
    c.env.DB.prepare(
      "UPDATE campaigns SET status = CASE WHEN status = 'recruiting' THEN 'running' ELSE status END,updated_at = ? WHERE id = ?",
    ).bind(current, id),
  ]);
  await recordEvent(c, "optin_confirmed", id, tester.session_id);
  return c.json({ currentDay: 1, optedInOn: today });
});

app.post("/api/campaigns/:id/check-in", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const campaign = await campaignById(c.env.DB, id);
  if (!new Set(["recruiting", "running"]).has(campaign.status))
    throw new ApiError("campaign_not_running", 409);
  const tester = await ownedTester(c, id);
  if (!tester.opted_in_on || tester.status === "withdrawn")
    throw new ApiError("optin_required", 409);
  const day = relativeTestDay(tester.opted_in_on, jstDay());
  if (!isCheckinDay(day))
    throw new ApiError(day > 14 ? "test_window_complete" : "invalid_test_day", 409);
  const payload = objectPayload(await parseJson(c, 1024));
  const result = enumText(payload, "result", new Set(["blocked", "used"]));
  const note = cleanText(payload, "note", 160, { allowEmpty: true, blockContact: true });
  try {
    await c.env.DB.prepare(
      "INSERT INTO checkins (campaign_id,tester_id,day_index,result,note,created_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, tester.id, day, result, note, nowSeconds())
      .run();
  } catch {
    throw new ApiError("already_checked_today", 409);
  }
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM checkins WHERE tester_id = ?")
    .bind(tester.id)
    .first<{ count: number }>();
  if ((total?.count ?? 0) >= 14)
    await c.env.DB.prepare("UPDATE testers SET status = 'completed',updated_at = ? WHERE id = ?")
      .bind(nowSeconds(), tester.id)
      .run();
  await recordEvent(c, "day_checked", id, tester.session_id);
  return c.json({ completedDays: total?.count ?? 1, dayIndex: day });
});

app.post("/api/campaigns/:id/feedback", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await campaignById(c.env.DB, id);
  const tester = await ownedTester(c, id);
  if (tester.status === "withdrawn") throw new ApiError("tester_withdrawn", 409);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM feedback WHERE tester_id = ?")
    .bind(tester.id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 20) throw new ApiError("feedback_limit_reached", 409);
  const payload = objectPayload(await parseJson(c, 1024));
  const category = enumText(payload, "category", feedbackCategories);
  const body = cleanText(payload, "body", 300, { blockContact: true });
  await c.env.DB.prepare(
    "INSERT INTO feedback (campaign_id,tester_id,category,body,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(id, tester.id, category, body, nowSeconds())
    .run();
  await recordEvent(c, "feedback_sent", id, tester.session_id);
  return c.json({ accepted: true }, 201);
});

app.post("/api/campaigns/:id/withdraw", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await campaignById(c.env.DB, id);
  const tester = await ownedTester(c, id);
  await c.env.DB.prepare("UPDATE testers SET status = 'withdrawn',updated_at = ? WHERE id = ?")
    .bind(nowSeconds(), tester.id)
    .run();
  return c.json({ withdrawn: true });
});

app.patch("/api/campaigns/:id/manage", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const campaign = await managerCampaign(c, id);
  const payload = objectPayload(await parseJson(c, 1536));
  const keys = Object.keys(payload).sort();
  if (keys.length === 1 && keys[0] === "notice") {
    const notice = cleanText(payload, "notice", 240, { allowEmpty: true, blockContact: true });
    await c.env.DB.prepare("UPDATE campaigns SET notice = ?,updated_at = ? WHERE id = ?")
      .bind(notice, nowSeconds(), id)
      .run();
    return c.json({ notice });
  }
  if (keys.length === 1 && keys[0] === "publicListing") {
    const publicListing = booleanValue(payload, "publicListing");
    await c.env.DB.prepare("UPDATE campaigns SET public_listing = ?,updated_at = ? WHERE id = ?")
      .bind(publicListing ? 1 : 0, nowSeconds(), id)
      .run();
    return c.json({ publicListing });
  }
  if (keys.length === 1 && keys[0] === "status") {
    const status = cleanText(payload, "status", 16);
    if (!new Set(["closed", "completed", "recruiting", "running"]).has(status))
      throw new ApiError("invalid_status", 400);
    if (campaign.status === "closed" || campaign.status === "completed")
      throw new ApiError("campaign_final", 409);
    await c.env.DB.prepare("UPDATE campaigns SET status = ?,updated_at = ? WHERE id = ?")
      .bind(status, nowSeconds(), id)
      .run();
    return c.json({ status });
  }
  throw new ApiError("invalid_request", 400);
});

app.post("/api/campaigns/:id/report", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await campaignById(c.env.DB, id);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c, 512));
  const reason = enumText(payload, "reason", reportReasons);
  try {
    await c.env.DB.prepare(
      "INSERT INTO content_reports (campaign_id,session_id,reason,created_at) VALUES (?,?,?,?)",
    )
      .bind(id, actor, reason, nowSeconds())
      .run();
  } catch {
    throw new ApiError("already_reported", 409);
  }
  const reports = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM content_reports WHERE campaign_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((reports?.count ?? 0) >= 3)
    await c.env.DB.prepare("UPDATE campaigns SET status = 'hidden',updated_at = ? WHERE id = ?")
      .bind(nowSeconds(), id)
      .run();
  return c.json({ accepted: true }, 202);
});

const csvSafe = (value: number | string) => {
  const text = String(value);
  const safe = /^[=+\-@]/u.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
};

app.get("/api/campaigns/:id/roster.csv", async (c) => {
  const id = validateId(c.req.param("id"));
  const campaign = await managerCampaign(c, id);
  const testers = await getTesters(c.env.DB, id);
  const checkins = await getCheckins(c.env.DB, id);
  const rows: Array<Array<number | string>> = [
    ["表示名", "端末", "Android", "状態", "参加日", "点灯日数"],
    ...testers.map((tester) => [
      tester.display_name,
      deviceLabels[tester.device_kind],
      tester.android_version,
      tester.status,
      tester.opted_in_on,
      completedTestDays(
        checkins.filter((item) => item.tester_id === tester.id).map((item) => item.day_index),
      ),
    ]),
  ];
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="shisou-' + id.slice(0, 8) + '.csv"');
  c.header("Cache-Control", "no-store");
  await recordEvent(c, "roster_exported", id, campaign.creator_session_id);
  return c.body("\uFEFF" + rows.map((row) => row.map(csvSafe).join(",")).join("\r\n"));
});

app.get("/api/campaigns/:id/roster.json", async (c) => {
  const id = validateId(c.req.param("id"));
  const campaign = await managerCampaign(c, id);
  c.header("Content-Disposition", 'attachment; filename="shisou-' + id.slice(0, 8) + '.json"');
  c.header("Cache-Control", "no-store");
  await recordEvent(c, "roster_exported", id, campaign.creator_session_id);
  return c.json({
    exportedAt: new Date().toISOString(),
    ...(await managerState(c.env.DB, campaign)),
  });
});

app.get("/health", (c) => c.json({ ok: true }));

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || !/\.[a-z0-9]{2,8}$/iu.test(c.req.path)) {
    return c.html(
      <Layout
        canonical={canonicalOrigin + "/"}
        description="指定された試走盤は見つかりませんでした。"
        noindex
        title="見つかりません｜試走灯"
      >
        <main class="not-found" id="main">
          <span class="dark-beacon" />
          <h1>試走盤が見つかりません。</h1>
          <a class="primary button-link" href="/">
            ホームへ
          </a>
        </main>
      </Layout>,
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof ApiError)
    return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
  console.error("unhandled_error", {
    message: error instanceof Error ? error.message : String(error),
    requestId: c.get("requestId"),
  });
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

export const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env) => {
  const timestamp = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM campaigns WHERE expires_at <= ?").bind(timestamp),
    env.DB.prepare("DELETE FROM product_events WHERE created_at <= ?").bind(timestamp - 45 * 86400),
  ]);
};

export { app, genreLabels, statusLabels };

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Bindings>;
