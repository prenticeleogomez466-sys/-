import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = join(rootDir, "data", "exports");
const wechatDir = join(rootDir, "data", "wechat");

export function getWechatConfig(env = process.env) {
  return {
    queryToken: env.WECHAT_QUERY_TOKEN || "",
    officialToken: env.WECHAT_OFFICIAL_TOKEN || env.WECHAT_QUERY_TOKEN || "",
    channelSecret: env.WECHAT_CHANNEL_SECRET || "",
    requireSignature: env.WECHAT_REQUIRE_SIGNATURE === "1",
    allowQueryToken: env.WECHAT_ALLOW_QUERY_TOKEN === "1",
    webhookUrl: env.WECHAT_WEBHOOK_URL || "",
    deliverySecret: env.WECHAT_DELIVERY_SECRET || env.WECHAT_CHANNEL_SECRET || "",
    timeoutMs: Number(env.WECHAT_TIMEOUT_MS ?? 12000),
    retryAttempts: Number(env.WECHAT_RETRY_ATTEMPTS ?? 3),
    maxBodyBytes: Number(env.WECHAT_MAX_BODY_BYTES ?? 65536),
    corsOrigin: env.WECHAT_CORS_ORIGIN || env.PUBLIC_CORS_ORIGIN || ""
  };
}

export async function handleWechatQuery({ method, url, headers = {}, rawBody = "" }, env = process.env) {
  const config = getWechatConfig(env);
  if (method === "GET" && url.searchParams.has("echostr")) return handleOfficialHandshake(url, config);
  if (method !== "GET" && method !== "POST") return { status: 405, body: { ok: false, error: "只支持 GET/POST" } };

  const officialPost = method === "POST" && hasOfficialWechatSignature(url) && looksLikeXml(rawBody);
  const auth = officialPost ? verifyOfficialMessageSignature(url, config) : verifyWechatRequest({ method, url, headers, rawBody }, config);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };

  const input = parseWechatInput(url, rawBody);
  const answer = buildWechatAnswer(input, env);
  writeWechatQueryLog({ input: sanitizeInputForLog(input), answer, auth: auth.mode });
  if (officialPost) return { status: 200, body: renderWechatXmlReply(input, answer), contentType: "application/xml; charset=utf-8" };
  return { status: 200, body: answer };
}

export function verifyWechatRequest({ method, url, headers = {}, rawBody = "" }, config = getWechatConfig()) {
  if (!config.queryToken) return { ok: false, status: 503, error: "微信查询令牌未配置：请设置 WECHAT_QUERY_TOKEN" };
  const authHeader = getHeader(headers, "authorization");
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = getHeader(headers, "x-wechat-query-token");
  const queryToken = config.allowQueryToken ? url.searchParams.get("token") : "";
  const token = bearer || headerToken || queryToken || "";
  if (!safeEqual(token, config.queryToken)) return { ok: false, status: 401, error: "微信通道鉴权失败" };

  if (config.requireSignature || getHeader(headers, "x-football-signature")) {
    const signature = getHeader(headers, "x-football-signature");
    const timestamp = getHeader(headers, "x-football-timestamp");
    const signatureCheck = verifyHmacSignature({ rawBody, timestamp, signature, secret: config.channelSecret });
    if (!signatureCheck.ok) return { ok: false, status: 401, error: signatureCheck.error };
    return { ok: true, mode: "bearer+hmac" };
  }
  return { ok: true, mode: "bearer" };
}

export function handleOfficialHandshake(url, config = getWechatConfig()) {
  if (!config.officialToken) return { status: 503, body: { ok: false, error: "微信官方 Token 未配置" } };
  const signature = url.searchParams.get("signature") || "";
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const echostr = url.searchParams.get("echostr") || "";
  const expected = buildOfficialSignature(config.officialToken, timestamp, nonce);
  if (!safeEqual(signature, expected)) return { status: 401, body: { ok: false, error: "微信官方签名校验失败" } };
  return { status: 200, body: echostr, contentType: "text/plain; charset=utf-8" };
}

export async function deliverDailyReportToWechat(packageResult) {
  const payload = {
    date: packageResult.date,
    message: `足球大模型日报已生成：${packageResult.dailyPath}`,
    xlsx: packageResult.dailyPath,
    master: packageResult.masterPath,
    sourceGate: {
      ok: packageResult.sourceGate?.ok ?? true,
      ageMinutes: packageResult.sourceGate?.ageMinutes ?? null
    },
    generatedAt: new Date().toISOString()
  };
  return deliverWechatPayload(payload);
}

export async function deliverWechatPayload(payload, env = process.env) {
  const config = getWechatConfig(env);
  const outbox = saveWechatOutbox(payload);
  if (!config.webhookUrl) return { mode: "local-outbox", ok: true, path: outbox.latestPath, archivedPath: outbox.archivedPath };
  const urlCheck = validateWebhookUrl(config.webhookUrl);
  if (!urlCheck.ok) {
    return { mode: "webhook", ok: false, error: urlCheck.error, path: outbox.latestPath };
  }

  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  if (config.deliverySecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["x-football-timestamp"] = timestamp;
    headers["x-football-signature"] = signBody(body, timestamp, config.deliverySecret);
  }

  let last = null;
  for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(config.webhookUrl, { method: "POST", headers, body, signal: controller.signal });
      const text = await response.text();
      clearTimeout(timeout);
      last = { ok: response.ok, status: response.status, body: text.slice(0, 500), attempt };
      if (response.ok) return { mode: "webhook", ok: true, status: response.status, attempt, path: outbox.latestPath };
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      clearTimeout(timeout);
      last = { ok: false, error: error.message, attempt };
    }
    await sleep(500 * attempt);
  }
  saveWechatFailure({ payload, last, failedAt: new Date().toISOString() });
  return { mode: "webhook", ok: false, ...last, path: outbox.latestPath };
}

export function buildWechatChannelHealth(date = todayInShanghai(), env = process.env) {
  const config = getWechatConfig(env);
  const latestOutbox = join(exportDir, "wechat-outbox-latest.json");
  const latestReport = join(exportDir, `football-recommendations-${date}.xlsx`);
  const gateStatus = readRealtimeGateStatus(date, env);
  const webhookCheck = validateWebhookUrl(config.webhookUrl);
  const checks = [
    { name: "微信查询入口鉴权令牌", ok: Boolean(config.queryToken), level: config.queryToken ? "ok" : "error", detail: config.queryToken ? "已配置" : "缺少 WECHAT_QUERY_TOKEN" },
    { name: "微信查询令牌强度", ok: config.queryToken.length >= 24, level: config.queryToken.length >= 24 ? "ok" : "warning", detail: config.queryToken.length >= 24 ? "长度合格" : "建议至少 24 位随机字符" },
    { name: "微信官方验签 Token", ok: Boolean(config.officialToken), level: config.officialToken ? "ok" : "warning", detail: config.officialToken ? "已配置" : "未配置，仅支持自有 HTTPS 网关鉴权" },
    { name: "HMAC 请求签名", ok: !config.requireSignature || Boolean(config.channelSecret), level: config.requireSignature && !config.channelSecret ? "error" : config.channelSecret ? "ok" : "warning", detail: config.channelSecret ? "已配置" : config.requireSignature ? "已强制签名但缺少 WECHAT_CHANNEL_SECRET" : "未强制，建议公网环境开启 WECHAT_REQUIRE_SIGNATURE=1" },
    { name: "URL 令牌暴露防护", ok: !config.allowQueryToken, level: config.allowQueryToken ? "warning" : "ok", detail: config.allowQueryToken ? "已允许 token 放在 URL，建议关闭" : "已禁止 URL token" },
    { name: "浏览器跨域限制", ok: config.corsOrigin !== "*", level: config.corsOrigin === "*" ? "warning" : "ok", detail: config.corsOrigin ? `允许来源：${config.corsOrigin}` : "默认不开放跨域" },
    { name: "Webhook 地址", ok: !config.webhookUrl || webhookCheck.ok, level: webhookCheck.ok ? "ok" : "warning", detail: config.webhookUrl ? maskUrl(config.webhookUrl) : "未配置，使用本地 outbox" },
    { name: "出站 outbox", ok: existsSync(latestOutbox), level: existsSync(latestOutbox) ? "ok" : "warning", detail: existsSync(latestOutbox) ? latestOutbox : "尚未生成" },
    { name: "今日 XLSX", ok: existsSync(latestReport), level: existsSync(latestReport) ? "ok" : "warning", detail: existsSync(latestReport) ? latestReport : "尚未生成" },
    { name: "实时数据闸门", ok: gateStatus.ok, level: gateStatus.ok ? "ok" : "warning", detail: gateStatus.detail }
  ];
  const errors = checks.filter((check) => check.level === "error" && !check.ok);
  const warnings = checks.filter((check) => check.level === "warning" && !check.ok);
  return {
    ok: errors.length === 0,
    generatedAt: new Date().toISOString(),
    date,
    summary: { total: checks.length, errors: errors.length, warnings: warnings.length },
    checks
  };
}

function buildWechatAnswer(input, env = process.env) {
  const date = input.date || latestAvailableDate();
  const gateStatus = readRealtimeGateStatus(date, env);
  const dailyStatus = readJsonIfExists(join(exportDir, `daily-evolution-status-${date}.json`));
  const latestOutbox = readJsonIfExists(join(exportDir, "wechat-outbox-latest.json"));
  const text = `${input.text || input.query || ""}`.trim();
  const wantsHealth = /健康|状态|通道|闸门|是否|稳定/.test(text);
  const wantsFourteen = /14|十四|胜负彩/.test(text);
  const wantsJingcai = /竞彩|推荐|今日|比赛/.test(text) || !wantsHealth;

  if (wantsHealth) {
    const health = buildWechatChannelHealth(date, env);
    return {
      ok: health.ok,
      type: "health",
      date,
      answer: `微信通道${health.ok ? "正常" : "存在风险"}；实时闸门：${gateStatus.ok ? "通过" : gateStatus.detail}；今日 XLSX：${latestOutbox?.xlsx ? "已生成" : "未生成"}。`,
      health,
      source: "football-ai-copilot"
    };
  }

  return {
    ok: true,
    type: wantsFourteen ? "shengfucai" : wantsJingcai ? "jingcai" : "general",
    date,
    answer: `已连接足球大模型。${date} 数据源闸门${gateStatus.ok ? "已通过" : gateStatus.detail}，推荐表${latestOutbox?.xlsx ? "已生成" : "未生成"}。${wantsFourteen ? "14场只输出胜平负、强胆最多4个，其余降为双选/全选，不输出比分和半全场。" : "竞彩输出胜平负、比分、半全场和赔率理由。"}`,
    xlsxReady: Boolean(latestOutbox?.xlsx),
    dailyOk: Boolean(dailyStatus?.ok),
    gateOk: gateStatus.ok,
    source: "football-ai-copilot"
  };
}

function parseWechatInput(url, rawBody) {
  if (rawBody) {
    if (looksLikeXml(rawBody)) {
      return {
        text: decodeXml(readXmlTag(rawBody, "Content")),
        date: safeDateOrNull(url.searchParams.get("date")),
        openid: readXmlTag(rawBody, "FromUserName") || null,
        toUserName: readXmlTag(rawBody, "ToUserName") || null,
        messageType: readXmlTag(rawBody, "MsgType") || null,
        rawType: "xml"
      };
    }
    try {
      const json = JSON.parse(rawBody);
      return {
        text: json.text ?? json.query ?? json.message ?? "",
        date: safeDateOrNull(json.date),
        openid: json.openid ?? json.fromUserName ?? null
      };
    } catch {
      return { text: rawBody.slice(0, 500), date: safeDateOrNull(url.searchParams.get("date")) };
    }
  }
  return {
    text: url.searchParams.get("q") ?? url.searchParams.get("text") ?? "",
    date: safeDateOrNull(url.searchParams.get("date"))
  };
}

function saveWechatOutbox(payload) {
  mkdirSync(exportDir, { recursive: true });
  mkdirSync(wechatDir, { recursive: true });
  const latestPath = join(exportDir, "wechat-outbox-latest.json");
  const archivedPath = join(wechatDir, `wechat-outbox-${safeFileTime(new Date())}.json`);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(latestPath, text, "utf8");
  writeFileSync(archivedPath, text, "utf8");
  return { latestPath, archivedPath };
}

function saveWechatFailure(payload) {
  mkdirSync(wechatDir, { recursive: true });
  writeFileSync(join(wechatDir, `wechat-failure-${safeFileTime(new Date())}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeWechatQueryLog(payload) {
  mkdirSync(wechatDir, { recursive: true });
  writeFileSync(join(wechatDir, `wechat-query-${safeFileTime(new Date())}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readRealtimeGateStatus(date, env = process.env) {
  const path = join(exportDir, `realtime-source-gate-${date}.json`);
  const payload = readJsonIfExists(path);
  const gate = payload?.gate ?? payload;
  if (!gate) return { ok: false, exists: false, path, detail: "缺少实时闸门" };
  const generatedAt = gate.generatedAt ? new Date(gate.generatedAt) : null;
  const ageMinutes = generatedAt && !Number.isNaN(generatedAt.getTime()) ? Math.max(0, Math.round((Date.now() - generatedAt.getTime()) / 60000)) : null;
  const maxAgeMinutes = Number(env.SOURCE_GATE_MAX_AGE_MINUTES ?? 30);
  const fresh = Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes;
  if (!gate.ok) return { ok: false, exists: true, path, ageMinutes, maxAgeMinutes, detail: `未通过：${gate.failures?.join("；") || "未知失败"}` };
  if (!fresh) return { ok: false, exists: true, path, ageMinutes, maxAgeMinutes, detail: `已过期 ${ageMinutes} 分钟，需重新刷新实时闸门` };
  return { ok: true, exists: true, path, ageMinutes, maxAgeMinutes, detail: `通过，${ageMinutes} 分钟前生成` };
}

function verifyOfficialMessageSignature(url, config) {
  if (!config.officialToken) return { ok: false, status: 503, error: "微信官方 Token 未配置" };
  const signature = url.searchParams.get("signature") || "";
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const expected = buildOfficialSignature(config.officialToken, timestamp, nonce);
  return safeEqual(signature, expected) ? { ok: true, mode: "wechat-official-sha1" } : { ok: false, status: 401, error: "微信官方消息签名校验失败" };
}

function verifyHmacSignature({ rawBody, timestamp, signature, secret }) {
  if (!secret) return { ok: false, error: "缺少 WECHAT_CHANNEL_SECRET，无法校验签名" };
  if (!signature || !timestamp) return { ok: false, error: "缺少 HMAC 签名或时间戳" };
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return { ok: false, error: "签名时间戳过期" };
  const expected = signBody(rawBody, timestamp, secret);
  return safeEqual(signature, expected) ? { ok: true } : { ok: false, error: "HMAC 签名不匹配" };
}

function signBody(rawBody, timestamp, secret) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function buildOfficialSignature(token, timestamp, nonce) {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

function hasOfficialWechatSignature(url) {
  return url.searchParams.has("signature") && url.searchParams.has("timestamp") && url.searchParams.has("nonce");
}

function looksLikeXml(value) {
  return /^\s*<\?xml|^\s*<xml[>\s]/i.test(String(value ?? ""));
}

function readXmlTag(xml, tag) {
  const match = String(xml ?? "").match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, "i"));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function renderWechatXmlReply(input, answer) {
  const content = answer.answer || JSON.stringify(answer);
  return [
    "<xml>",
    `<ToUserName><![CDATA[${safeCdata(input.openid || "")}]]></ToUserName>`,
    `<FromUserName><![CDATA[${safeCdata(input.toUserName || "")}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    "<MsgType><![CDATA[text]]></MsgType>",
    `<Content><![CDATA[${safeCdata(content)}]]></Content>`,
    "</xml>"
  ].join("");
}

function safeCdata(value) {
  return String(value ?? "").replaceAll("]]>", "]]]]><![CDATA[>");
}

function validateWebhookUrl(value) {
  if (!value) return { ok: true };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return { ok: false, error: "WECHAT_WEBHOOK_URL 必须使用 HTTPS" };
    return { ok: true };
  } catch {
    return { ok: false, error: "WECHAT_WEBHOOK_URL 格式无效" };
  }
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return "";
}

function safeEqual(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function latestAvailableDate() {
  const files = existsSync(exportDir) ? readDirectorySafe(exportDir) : [];
  const dates = files.map((file) => file.match(/daily-evolution-status-(\d{4}-\d{2}-\d{2})\.json/)?.[1]).filter(Boolean).sort();
  return dates.at(-1) ?? todayInShanghai();
}

function readDirectorySafe(path) {
  try {
    return existsSync(path) ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

function safeDateOrNull(value) {
  return String(value ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function sanitizeInputForLog(input) {
  return {
    text: String(input.text ?? "").slice(0, 200),
    date: input.date ?? null,
    openid: input.openid ? maskOpenid(input.openid) : null,
    messageType: input.messageType ?? null,
    rawType: input.rawType ?? null
  };
}

function maskOpenid(value) {
  const text = String(value);
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function safeFileTime(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function maskUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.pathname ? "/..." : ""}`;
  } catch {
    return "格式无效";
  }
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
