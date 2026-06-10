import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getDataSubdir, getExportDir } from "./paths.js";
import { buildCredentialStatus } from "./source-credentials.js";
import { recommendFixtures } from "./prediction-engine.js";
// renderTodayMobileHtml(today-mobile-view)已摘除:/today 改回放唯一出口静态页,不再独立装配(2026-06-10)。
import { getWechatConfig, handleWechatQuery } from "./wechat-channel.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const advancedDir = getDataSubdir("advanced");
const port = Number(process.env.PORT ?? 3000);

export function createFootballServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "OPTIONS") return send(response, "", 204);
      if (request.method === "GET" && url.pathname === "/") return send(response, renderDashboard(), 200, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/framework") return send(response, renderFramework(), 200, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/today") {
        // 2026-06-10 输出层单写者收敛(缺陷#7):/today 不再独立装配(renderTodayMobileHtml 旁路曾致
        // 实时页与 xlsx/手机静态页 口径分叉、三面三个日期),改为直接回放唯一出口 today-full-coverage 写出的静态页。
        const canonical = "D:/Temp/webshare_lingdao/今日足球推荐.html";
        if (!existsSync(canonical)) {
          return send(response, `当日交付页未生成(唯一出口未跑)。先跑:node scripts/today-full-coverage.mjs ${todayInShanghai()} --jconly`, 503, "text/plain; charset=utf-8");
        }
        const page = readFileSync(canonical, "utf8");
        const wantDate = url.searchParams.get("date");
        const pageDate = page.match(/神选·竞彩·(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
        if (wantDate && pageDate && wantDate !== pageDate) {
          return send(response, `请求日期=${wantDate},但当前交付页日期=${pageDate}(本路由不再独立装配、不冒充)。重出:node scripts/today-full-coverage.mjs ${wantDate} --jconly`, 409, "text/plain; charset=utf-8");
        }
        return send(response, page, 200, "text/html; charset=utf-8");
      }
      if (url.pathname === "/api/health") return send(response, { status: "ok", service: "football-ai-copilot" });
      if (url.pathname === "/api/credentials") return send(response, await buildCredentialStatus());
      if (url.pathname === "/api/model-view") return send(response, buildModelView(url.searchParams.get("date") ?? todayInShanghai()));
      if (url.pathname === "/api/predictions") return send(response, recommendFixtures(url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)));
      if (url.pathname === "/api/wechat/query") return handleWechatHttp(request, response, url);
      return send(response, { error: "not found" }, 404);
    } catch (error) {
      return send(response, { ok: false, error: error.message }, 500);
    }
  });
}

function renderFramework() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>足球大模型框架</title>
  <style>
    :root { color-scheme: dark; --bg:#070b17; --panel:#101832; --card:#151f3d; --line:#2b3b68; --text:#edf3ff; --muted:#9da9c9; --blue:#6aa7ff; --green:#31d39b; --yellow:#ffcc66; --red:#ff6b7a; --purple:#b58cff; }
    * { box-sizing:border-box; } body { margin:0; font-family:"Microsoft YaHei", Inter, system-ui, sans-serif; color:var(--text); background:linear-gradient(135deg,#071024,#101832 48%,#090d19); }
    header { padding:30px 36px 14px; display:flex; justify-content:space-between; gap:18px; align-items:end; }
    h1 { margin:0; font-size:32px; letter-spacing:.5px; } h2 { margin:0 0 12px; font-size:18px; } .sub,.muted { color:var(--muted); }
    main { padding:0 36px 36px; display:grid; gap:18px; } .card { background:rgba(16,24,50,.9); border:1px solid var(--line); border-radius:20px; padding:18px; box-shadow:0 22px 70px rgba(0,0,0,.25); }
    .stack { display:grid; grid-template-columns:1.05fr 1.1fr 1.1fr 1.1fr 1fr; gap:14px; align-items:stretch; }
    .stage { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:14px; min-height:260px; position:relative; }
    .stage:after { content:"→"; position:absolute; right:-15px; top:118px; color:var(--blue); font-size:26px; font-weight:800; }
    .stage:last-child:after { content:""; }
    .stage h3 { margin:0 0 10px; font-size:17px; } .tag { display:inline-block; padding:3px 8px; border:1px solid var(--line); border-radius:999px; font-size:12px; color:#c9d6ff; margin-bottom:10px; }
    ul { margin:8px 0 0; padding-left:18px; } li { margin:8px 0; color:#dce6ff; } code { color:#bcd1ff; background:#0b1228; padding:2px 5px; border-radius:6px; }
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; } .mini { background:#0d152d; border:1px solid var(--line); border-radius:16px; padding:14px; }
    .ok { color:var(--green); } .warn { color:var(--yellow); } .bad { color:var(--red); } .purple { color:var(--purple); }
    .rules { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; } .rule { border-left:4px solid var(--blue); background:#0d152d; border-radius:14px; padding:14px; }
    a { color:#9fc3ff; text-decoration:none; } a:hover { text-decoration:underline; }
    @media (max-width:1200px){ .stack,.grid,.rules{grid-template-columns:1fr 1fr}.stage:after{content:""} } @media (max-width:760px){ header{display:block}.stack,.grid,.rules{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>足球大模型框架</h1>
      <div class="sub">不是推荐列表；这是系统架构：数据如何进入、如何过闸、如何建特征、如何推理、如何审计输出。</div>
    </div>
    <div class="sub"><a href="/">推荐可视图</a> · <a href="/api/model-view?date=${todayInShanghai()}">JSON 视图</a></div>
  </header>
  <main>
    <section class="card">
      <h2>一、总框架流水线</h2>
      <div class="stack">
        <div class="stage">
          <span class="tag">Data Sources</span>
          <h3>数据源层</h3>
          <ul>
            <li>官方赛程：竞彩 / 14 场</li>
            <li>赔率：欧赔、亚盘、让球、比分、半全场</li>
            <li>高级源：Elo、状态、天气、新闻</li>
            <li class="warn">待授权：伤停、首发、xG</li>
          </ul>
        </div>
        <div class="stage">
          <span class="tag">Realtime Gate</span>
          <h3>实时闸门层</h3>
          <ul>
            <li><code>realtime-source-gate.js</code></li>
            <li>检查赔率快照完整度</li>
            <li>检查快照实时性</li>
            <li class="bad">失败则阻断正式推荐</li>
          </ul>
        </div>
        <div class="stage">
          <span class="tag">Feature Engine</span>
          <h3>特征工程层</h3>
          <ul>
            <li>赔率隐含概率 / 返还率</li>
            <li>初赔到即时赔率漂移</li>
            <li>亚盘盘口与水位偏移</li>
            <li>高级数据质量分与风险标签</li>
          </ul>
        </div>
        <div class="stage">
          <span class="tag">Prediction Core</span>
          <h3>预测推理层</h3>
          <ul>
            <li><code>prediction-engine.js</code></li>
            <li>先确定胜平负主方向</li>
            <li>再派生比分与半全场</li>
            <li>14 场胆/双/全严格限量</li>
          </ul>
        </div>
        <div class="stage">
          <span class="tag">Audit & Export</span>
          <h3>审计输出层</h3>
          <ul>
            <li>一致性审计：比分/半全场不冲突</li>
            <li>完整度标准：对齐 2026-05-15 基准</li>
            <li>顶级就绪审计：缺口透明显示</li>
            <li>Excel / 微信 / API 输出</li>
          </ul>
        </div>
      </div>
    </section>
    <section class="grid">
      <div class="card">
        <h2>二、核心文件地图</h2>
        <ul>
          <li><code>china-web-sources.js</code>：官方网页源</li>
          <li><code>odds-crawler.js</code>：赔率抓取与补源</li>
          <li><code>market-data-store.js</code>：赔率快照仓库</li>
          <li><code>advanced-data-runner.js</code>：高级源同步</li>
          <li><code>advanced-football-features.js</code>：高级特征</li>
          <li><code>prediction-engine.js</code>：预测主引擎</li>
        </ul>
      </div>
      <div class="card">
        <h2>三、模型硬闸门</h2>
        <div class="mini"><b class="bad">正式推荐前必须通过</b><br /><code>npm run crawler:realtime:strict -- --date=YYYY-MM-DD</code></div>
        <br />
        <div class="mini"><b class="bad">完整度必须通过</b><br /><code>npm run standard:check -- --date=YYYY-MM-DD</code></div>
        <br />
        <div class="mini"><b class="warn">顶级就绪单独审计</b><br /><code>npm run model:top-tier-audit -- --date=YYYY-MM-DD</code></div>
      </div>
      <div class="card">
        <h2>四、当前顶级缺口</h2>
        <ul>
          <li class="ok">已接：实时赔率、Elo、状态、天气、新闻</li>
          <li class="warn">缺：伤停 <code>INJURY_SOURCE_URL</code></li>
          <li class="warn">缺：预计首发 <code>LINEUP_SOURCE_URL</code></li>
          <li class="warn">缺：xG <code>XG_SOURCE_URL</code></li>
          <li class="purple">所以可严格推荐，但不能称“顶级完全就绪”</li>
        </ul>
      </div>
    </section>
    <section class="card">
      <h2>五、你之前要求的关键约束已经放进框架</h2>
      <div class="rules">
        <div class="rule"><b>先胜平负</b><br /><span class="muted">所有比分、半全场必须从已定胜平负派生。</span></div>
        <div class="rule"><b>不冲突</b><br /><span class="muted">比分/半全场与胜平负冲突会抛错阻断。</span></div>
        <div class="rule"><b>胆少而精</b><br /><span class="muted">14 场定胆有最大数量、最小概率差、最小置信门槛。</span></div>
        <div class="rule"><b>不造数据</b><br /><span class="muted">高级数据缺失必须标缺口，不用推测冒充真实数据。</span></div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function buildModelView(date) {
  const predictions = recommendFixtures(date);
  const topTier = readJsonIfExists(join(exportDir, `top-tier-model-audit-${date}.json`));
  const stageAudit = readJsonIfExists(join(exportDir, `model-stage-audit-${date}.json`));
  const standard = readJsonIfExists(join(exportDir, `data-completeness-standard-${date}.json`));
  const modelAudit = readJsonIfExists(join(exportDir, `model-structure-audit-${date}.json`));
  const advanced = readJsonIfExists(join(advancedDir, `${date}.json`));
  return {
    date,
    generatedAt: new Date().toISOString(),
    standard: standard?.summary ?? null,
    topTier: topTier ? { topTierReady: topTier.topTierReady, summary: topTier.summary, layers: topTier.advancedLayers } : null,
    stageAudit: stageAudit ? { ok: stageAudit.ok, summary: stageAudit.summary, stages: stageAudit.stages } : null,
    modelAudit: modelAudit?.summary ?? null,
    advancedLayers: Object.fromEntries(Object.entries(advanced?.layers ?? {}).map(([key, value]) => [key, { ok: value.ok, count: value.count, source: value.source, warning: value.warning ?? null }])),
    recommendations: {
      fixtures: predictions.fixtures,
      fourteen: predictions.fourteen,
      rows: predictions.predictions.map((item) => ({
        sequence: item.fixture.sequence,
        marketType: item.fixture.marketType,
        competition: item.fixture.competition,
        match: `${item.fixture.homeTeam} vs ${item.fixture.awayTeam}`,
        pick: item.pick.label,
        probability: item.pick.probability,
        confidence: item.confidence,
        risk: item.risk,
        bankroll: item.bankroll,
        score: item.scorePicks.primary,
        halfFull: item.halfFullPicks.primary,
        quality: item.advancedFeatures?.quality
      }))
    }
  };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function renderDashboard() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>足球大模型可视图</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a31; --card:#17213d; --line:#2a365c; --text:#eaf0ff; --muted:#98a6ca; --ok:#35d39b; --warn:#ffcc66; --bad:#ff6b7a; --blue:#6aa7ff; }
    * { box-sizing: border-box; } body { margin:0; font-family:"Microsoft YaHei", Inter, system-ui, sans-serif; background:radial-gradient(circle at top left,#1d2b57 0,#0b1020 42%); color:var(--text); }
    header { padding:28px 34px 16px; display:flex; gap:18px; justify-content:space-between; align-items:end; }
    h1 { margin:0; font-size:30px; } .sub { color:var(--muted); margin-top:8px; } input,button { background:#0e1730; color:var(--text); border:1px solid var(--line); border-radius:10px; padding:10px 12px; } button { cursor:pointer; border-color:#3d63b8; }
    main { padding:0 34px 34px; display:grid; gap:18px; } .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; } .wide { grid-column:1/-1; }
    .card { background:rgba(18,26,49,.88); border:1px solid var(--line); border-radius:18px; padding:18px; box-shadow:0 18px 60px rgba(0,0,0,.24); }
    .kpi { font-size:28px; font-weight:800; margin-top:8px; } .label,.muted { color:var(--muted); } .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
    .flow { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; align-items:center; } .node { min-height:94px; border:1px solid var(--line); border-radius:16px; padding:14px; background:var(--card); position:relative; }
    .node:after { content:"→"; position:absolute; right:-15px; top:33px; color:var(--blue); font-size:22px; } .node:last-child:after { content:""; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:10px; text-align:left; } th { color:#b9c7ee; } tr:hover { background:#17213d; }
    .pill { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    @media (max-width:1100px){ .grid,.flow{grid-template-columns:1fr 1fr}.node:after{content:""} } @media (max-width:700px){ header{display:block}.grid,.flow{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <header>
    <div><h1>足球大模型可视图</h1><div class="sub">实时闸门 → 赔率快照 → 高级数据层 → 预测一致性 → 竞彩/14场输出</div></div>
    <div><input id="date" type="date" /><button onclick="loadView()">刷新可视图</button></div>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="label">数据完整度</div><div id="k-standard" class="kpi">--</div><div class="muted">fixtures / realtime</div></div>
      <div class="card"><div class="label">顶级就绪</div><div id="k-top" class="kpi">--</div><div id="k-missing" class="muted">--</div></div>
      <div class="card"><div class="label">模型审计</div><div id="k-audit" class="kpi">--</div><div class="muted">errors / warnings</div></div>
      <div class="card"><div class="label">今日比赛</div><div id="k-fixtures" class="kpi">--</div><div class="muted">竞彩 + 14场</div></div>
    </section>
    <section class="card wide">
      <h2>模型链路</h2>
      <div class="flow">
        <div class="node"><b>官方赛程</b><p class="muted">竞彩/14场分离，按业务日落盘</p></div>
        <div class="node"><b>实时闸门</b><p class="muted">赔率快照必须完整且实时</p></div>
        <div class="node"><b>高级数据</b><p class="muted">Elo、状态、天气、新闻、授权伤停/xG</p></div>
        <div class="node"><b>预测引擎</b><p class="muted">先定胜平负，再派生比分/半全场</p></div>
        <div class="node"><b>输出审计</b><p class="muted">胆严格筛选，冲突直接阻断</p></div>
      </div>
    </section>
    <section class="card wide"><h2>高级数据层</h2><div id="layers"></div></section>
    <section class="card wide"><h2>推荐可视表</h2><div id="rows"></div></section>
  </main>
  <script>
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    document.getElementById('date').value = today;
    function cls(ok, warn){ return ok ? 'ok' : warn ? 'warn' : 'bad'; }
    async function loadView(){
      const date = document.getElementById('date').value || today;
      const data = await fetch('/api/model-view?date=' + encodeURIComponent(date)).then(r => r.json());
      const standard = data.standard || {};
      document.getElementById('k-standard').innerHTML = '<span class="' + cls(standard.complete === standard.fixtures && standard.realtime === standard.fixtures, true) + '">' + (standard.complete ?? '--') + '/' + (standard.fixtures ?? '--') + '</span>';
      document.getElementById('k-top').innerHTML = '<span class="' + cls(data.topTier?.topTierReady, data.topTier) + '">' + (data.topTier?.topTierReady ? 'READY' : 'NOT READY') + '</span>';
      document.getElementById('k-missing').textContent = (data.topTier?.summary?.missingRequired || []).join('、') || '无缺口';
      document.getElementById('k-audit').innerHTML = '<span class="' + cls(data.modelAudit?.errors === 0, data.modelAudit?.warnings > 0) + '">' + (data.modelAudit?.errors ?? '--') + '/' + (data.modelAudit?.warnings ?? '--') + '</span>';
      document.getElementById('k-fixtures').textContent = data.recommendations?.fixtures ?? '--';
      document.getElementById('layers').innerHTML = renderLayers(data);
      document.getElementById('rows').innerHTML = renderRows(data.recommendations?.rows || []);
    }
    function renderLayers(data){
      const layers = data.topTier?.layers || [];
      return '<table><thead><tr><th>层</th><th>状态</th><th>来源</th><th>覆盖</th></tr></thead><tbody>' + layers.map(l => '<tr><td>' + l.label + '</td><td><span class="pill ' + cls(l.configured, false) + '">' + l.status + '</span></td><td>' + (l.source || '-') + '</td><td>' + (l.count || 0) + '</td></tr>').join('') + '</tbody></table>';
    }
    function renderRows(rows){
      return '<table><thead><tr><th>序号</th><th>类型</th><th>赛事</th><th>比赛</th><th>胜平负</th><th>概率</th><th>置信</th><th>风险</th><th>比分</th><th>半全场</th><th>质量</th></tr></thead><tbody>' + rows.map(r => '<tr><td>' + r.sequence + '</td><td>' + r.marketType + '</td><td>' + r.competition + '</td><td>' + r.match + '</td><td>' + r.pick + '</td><td>' + Math.round((r.probability || 0) * 100) + '%</td><td>' + r.confidence + '</td><td>' + r.risk + '</td><td>' + r.score + '</td><td>' + r.halfFull + '</td><td>' + (r.quality?.grade || '-') + ' / ' + (r.quality?.score ?? '-') + '</td></tr>').join('') + '</tbody></table>';
    }
    loadView();
  </script>
</body>
</html>`;
}

async function handleWechatHttp(request, response, url) {
  const config = getWechatConfig();
  const rawBody = request.method === "POST" ? await readRequestBody(request, config.maxBodyBytes) : "";
  const result = await handleWechatQuery({ method: request.method, url, headers: request.headers, rawBody });
  return send(response, result.body, result.status, result.contentType);
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`请求体过大，最大允许 ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, value, status = 200, contentType = "application/json; charset=utf-8") {
  const config = getWechatConfig();
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const headers = {
    "content-type": contentType,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-wechat-query-token,x-football-signature,x-football-timestamp",
    "x-content-type-options": "nosniff"
  };
  if (config.corsOrigin) headers["access-control-allow-origin"] = config.corsOrigin;
  response.writeHead(status, headers);
  response.end(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createFootballServer().listen(port, () => console.log(`football-ai-copilot listening on http://localhost:${port}`));
}
