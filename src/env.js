import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { getDataDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

// 中国服务器(sporttery.cn / lottery.gov.cn)从 Node 端访问时容易踩三个坑:
//   1. DNS 优先返回 IPv6,但很多家宽 IPv6 路由不通,需要 ipv4first;
//   2. undici 默认 connect 总预算 10s,逐 IP 串行尝试容易耗尽;
//   3. 用户机常配了系统级代理(VPN 客户端 / 西部世界 / Clash 等),
//      PowerShell 自动用,但 Node fetch 不读 Windows Internet Settings,
//      导致 PowerShell 通而 Node 死等 TCP SYN → ETIMEDOUT。
// 在 env.js 模块加载时把这三件事一起处理:
//   - DNS 顺序改成 ipv4first(FOOTBALL_DNS_ORDER=verbatim 可恢复)
//   - undici 全局 connect/headers/body 超时拉到 60s
//   - 自动检测代理:HTTPS_PROXY / HTTP_PROXY / Windows 注册表 ProxyServer
//     都没有时,走直连。设 FOOTBALL_DISABLE_AUTO_PROXY=1 可禁用注册表自动探测。
if ((process.env.FOOTBALL_DNS_ORDER ?? "ipv4first") === "ipv4first") {
  try { dns.setDefaultResultOrder("ipv4first"); } catch { /* 老版本 Node 不支持时静默 */ }
}
configureHttpDispatcher();

function configureHttpDispatcher() {
  const connectTimeout = Number(process.env.FOOTBALL_HTTP_CONNECT_TIMEOUT_MS ?? "60000");
  const headersTimeout = Number(process.env.FOOTBALL_HTTP_HEADERS_TIMEOUT_MS ?? "60000");
  const bodyTimeout = Number(process.env.FOOTBALL_HTTP_BODY_TIMEOUT_MS ?? "60000");
  const proxy = resolveSystemProxy();
  try {
    if (proxy) {
      setGlobalDispatcher(new ProxyAgent({ uri: proxy, requestTls: { timeout: connectTimeout }, headersTimeout, bodyTimeout }));
      if (!process.env.FOOTBALL_HTTP_PROXY) process.env.FOOTBALL_HTTP_PROXY = proxy;
    } else {
      setGlobalDispatcher(new Agent({ connect: { timeout: connectTimeout }, headersTimeout, bodyTimeout }));
    }
  } catch { /* undici 不可用时静默,fetch 用默认 10s 直连 */ }
}

function resolveSystemProxy() {
  const explicit = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (explicit) return normalizeProxyUri(explicit);
  if (process.env.FOOTBALL_DISABLE_AUTO_PROXY === "1") return null;
  if (process.platform !== "win32") return null;
  try {
    // reg query 一次只能 query 一个 /v,所以分两次
    const base = '"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"';
    const enabledOut = execSync(`reg query ${base} /v ProxyEnable`, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(enabledOut)) return null;
    const serverOut = execSync(`reg query ${base} /v ProxyServer`, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    return match ? normalizeProxyUri(match[1]) : null;
  } catch { return null; }
}

function normalizeProxyUri(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // 注册表里可能形如 "http=127.0.0.1:7890;https=127.0.0.1:7890" 或单独 host:port
  const httpsPart = trimmed.split(";").find((part) => part.startsWith("https=")) ?? trimmed.split(";")[0];
  const cleaned = httpsPart.replace(/^https?=/, "");
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `http://${cleaned}`;
}

const DEFAULT_ENV = {
  BANKROLL_RISK_POLICY: "1",
  BANKROLL_MAX_KELLY_FRACTION: "0.25",
  BANKROLL_MAX_STAKE_PCT: "0.02",
  BANKROLL_MIN_EV: "0.02",
  BANKROLL_DRAWDOWN_GUARD: "0.35",
  SOURCE_GATE_REQUIRE_FULL_ODDS: "1",
  FOOTBALL_FAST_OFFICIAL_MODE: "1",
  CHINA_SOURCE_RETRY_ATTEMPTS: "2",
  CHINA_SOURCE_TIMEOUT_MS: "8000",
  ODDS_CRAWLER_RETRY_ATTEMPTS: "2",
  ODDS_CRAWLER_TIMEOUT_MS: "8000",
  SINA_SFC_ODDS_ENABLED: "1",
  ODDS1X2_ODDS_ENABLED: "0",
  SGODDS_ODDS_ENABLED: "0",
  BETEXPLORER_ODDS_ENABLED: "0",
  LIAOGOU_ODDS_ENABLED: "0",
  FIVEHUNDRED_JC_ASIAN_ENABLED: "0",
  FIVEHUNDRED_SFC_ASIAN_ENABLED: "0",
  NOWSCORE_ODDS_ENABLED: "0",
  CUBEGOAL_ODDS_ENABLED: "0"
};

export function loadLocalEnv(paths = [join(rootDir, ".env"), join(getDataDir(), "local.env")]) {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (parsed && !process.env[parsed.key]) process.env[parsed.key] = parsed.value;
    }
  }
}

function parseEnvLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const index = trimmed.indexOf("=");
  if (index <= 0) return null;
  const key = trimmed.slice(0, index).trim();
  const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  return /^[A-Z_][A-Z0-9_]*$/i.test(key) ? { key, value } : null;
}

export function applyDefaultEnv(defaults = DEFAULT_ENV) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();
applyDefaultEnv();
