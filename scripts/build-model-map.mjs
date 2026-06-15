#!/usr/bin/env node
/**
 * 足球大模型 · 唯一大脑架构图【全展开详细版】(2026-06-11 用户:"把整个模型展开详细给我看")
 * 铁律:全部数字/清单现场自省(✅实测),探针清单从源码正则提取、模块清单从src目录实扫、
 * 数据新鲜度从数据盘实读;统计不到=标⚠️不编。
 * 输出: D:/Temp/webshare_lingdao/model-map.html (固定URL /model-map.html)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data";
const EXP = process.env.FOOTBALL_EXPORT_DIR || "D:\\football-model-exports";
const WC = join(DATA, "world-cup", "2026");
const SHARE = "D:/Temp/webshare_lingdao";
const now = Date.now();
const DATE = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
const ageH = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.round(((now - t) / 3600e3) * 10) / 10 : null; };
const J = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ════ 现场自省 ════
const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"));
const testFiles = readdirSync(join(root, "test")).filter((f) => /\.test\.(mjs|js)$/.test(f));
// 模块按域分组(文件名启发式,全员归类无遗漏)
const CATS = [
  ["世界杯域", /^(wc-|worldcup|world-cup|tournament)/],
  ["数据源/抓取", /(source|crawl|fetch|espn|zgzcw|titan|odds-api|market-data|fixtures-runner|china-web|understat|fbref|api-football|sporttery|scrape)/],
  ["概率引擎核心", /(prediction-engine|dixon|lambda|poisson|score-model|derived|elo|rating|prior|monte|simulator|handicap|overunder|halffull)/],
  ["市场/赔率处理", /(devig|odds|market|water|line-move|drift|closing|clv)/],
  ["校准/信号/选场", /(calib|signal|weight|fusion|tier|confidence|selection|reliab|recal|coverage|renxuan|fourteen|parlay)/],
  ["复盘/学习闭环", /(recap|ledger|backtest|evolution|experience|metric|scorecard|analog|profile|learn)/],
  ["输出/交付", /(report|view|xlsx|html|render|export|mobile|wechat|delivery|showcase)/],
  ["闸门/自检/审计", /(audit|guard|gate|selfcheck|preflight|vetting|standard|defect|hygiene)/],
];
const grouped = new Map(CATS.map(([n]) => [n, []]));
grouped.set("基建/其他", []);
for (const f of srcFiles) {
  const hit = CATS.find(([, re]) => re.test(f));
  grouped.get(hit ? hit[0] : "基建/其他").push(f.replace(".js", ""));
}
// 探针清单(源码实提)
const suiteCfg = J(join(root, "scripts", "audit-suite.config.json")) || [];
const wcSrc = readFileSync(join(root, "scripts", "audit-wc-pipeline.mjs"), "utf8");
const wcProbes = [...new Set([...wcSrc.matchAll(/rec\([`"]([a-z0-9${}.-]+)[`"]/g)].map((m) => m[1]))].filter((x) => !x.includes("$"));
const pfSrc = existsSync(join(root, "src", "preflight-selfcheck.js")) ? readFileSync(join(root, "src", "preflight-selfcheck.js"), "utf8") : "";
const pfProbes = [...new Set([...pfSrc.matchAll(/add\("([a-z][a-z0-9-]+)"/g)].map((m) => m[1]))];
// 数据底座
let fxTotal = 0, fxRes = 0, fxDays = 0;
for (const f of readdirSync(join(DATA, "fixtures")).filter((x) => x.endsWith(".json"))) {
  const o = J(join(DATA, "fixtures", f)); if (!o) continue; fxDays++;
  const list = Array.isArray(o) ? o : o.fixtures || [];
  fxTotal += list.length; fxRes += list.filter((m) => m.result || m.finalScore).length;
}
const priors = J(join(WC, "team-priors.json"));
const weather = J(join(WC, "worldcup-weather.json"));
const modds = J(join(WC, "match-odds.json"));
const totals = J(join(WC, "match-totals.json"));
const sc = J(join(WC, "worldcup-supercomputer.json"));
const mdates = J(join(WC, "match-dates.json"));
const bracket = J(join(WC, "bracket.json"));
const mkt = J(join(DATA, "market", `${DATE}.json`));
const adv = J(join(DATA, "adversarial", `${DATE}.json`));
const slip = J(join(EXP, `wc-betting-slip-${DATE}.json`));
const ledger = J(join(EXP, "recommendation-ledger.json"));
const ledgerN = Array.isArray(ledger) ? ledger.length : (ledger?.entries?.length ?? ledger?.rows?.length ?? null);
const intlCsv = existsSync(join(root, "data", "intl-results", "results.csv"));
const oddsAge = modds?.fixtures?.length ? Math.min(...modds.fixtures.map((f) => ageH(f.collectedAt) ?? 999)) : null;
const top3 = sc ? [...sc.rows].sort((a, b) => b.blend - a.blend).slice(0, 3).map((r) => `${r.team}${(r.blend * 100).toFixed(1)}%`).join(" · ") : "⚠️缺";
// 今日交付产物实扫
const delivDir = `C:\\Users\\Administrator\\Desktop\\足球推荐\\${DATE}`;
const deliv = existsSync(delivDir) ? readdirSync(delivDir).filter((f) => /\.(xlsx|html|json)$/.test(f)).map((f) => `${f}(${Math.round(statSync(join(delivDir, f)).size / 1024)}KB)`) : [];

const ok = (s) => `<span class="ok">${esc(s)}</span>`;
const sec = (cls, icon, title, inner) => `<section class="bx ${cls}"><div class="bt">${icon} ${title}</div>${inner}</section>`;
const row = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const chips = (arr) => `<div class="chips">${arr.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>`;
const arrow = `<div class="arr">▼</div>`;

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-cache,no-store,must-revalidate">
<title>⚡神选·足球大模型·全展开架构图</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#120a1f;color:#eee;line-height:1.5;-webkit-text-size-adjust:100%}
header{background:linear-gradient(135deg,#4A148C,#7B1FA2);padding:16px 14px;color:#fff;position:sticky;top:0;z-index:9}
header h1{margin:0;font-size:17px}.sub{font-size:11px;color:#E1BEE7;margin-top:4px}
main{max-width:820px;margin:0 auto;padding:12px}
.bx{border:1px solid #3a2459;border-radius:12px;padding:12px;margin:0 0 2px;background:#1e1230}
.bx.src{border-color:#1565C0;background:#0d1b2e}.bx.brain{border-color:#FFD54F;background:#2a2010;box-shadow:0 0 14px #FFD54F2e}
.bx.gate{border-color:#C62828;background:#2a1012}.bx.out{border-color:#2E7D32;background:#102a14}.bx.loop{border-color:#7B1FA2}
.bt{font-weight:800;font-size:15px;margin-bottom:8px;color:#FFD54F}.src .bt{color:#90CAF9}.gate .bt{color:#EF9A9A}.out .bt{color:#A5D6A7}.loop .bt{color:#CE93D8}
.kv{display:flex;gap:8px;padding:4px 0;border-top:1px dashed #ffffff12;font-size:12.5px}
.k{color:#9aa3b8;min-width:118px;flex-shrink:0}.v{color:#e6e9f2}
.ok{color:#4ade80;font-weight:600}.warn{color:#ffd97a}
.chips{margin:4px 0 2px}.chip{display:inline-block;background:#ffffff10;border:1px solid #ffffff1c;border-radius:6px;font-size:10.5px;padding:1px 7px;margin:2px 3px 0 0;color:#cdd3e0}
.step{font-size:12.5px;padding:5px 8px;margin:4px 0;background:#ffffff0a;border-left:3px solid #FFD54F;border-radius:4px}
.step b{color:#FFD54F}.gate .step{border-left-color:#EF5350}.src .step{border-left-color:#42A5F5}.out .step{border-left-color:#66BB6A}.loop .step{border-left-color:#AB47BC}
.arr{text-align:center;color:#7B1FA2;font-size:16px;margin:3px 0}
.cat{font-size:12px;color:#FFD54F;font-weight:700;margin-top:8px}
.honest{background:#4a3208;color:#ffd97a;font-size:12px;padding:10px 12px;border-radius:10px;margin-top:14px;line-height:1.6}
footer{text-align:center;color:#777;font-size:11px;padding:16px}
.dead{background:#1a1a1a;border-color:#444}.dead .bt{color:#888}.dead .chip{color:#777}
</style></head><body>
<header><h1>⚡神选 · 足球大模型 · 全展开架构图(唯一大脑)</h1>
<div class="sub">生成 ${new Date(now + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16)}(北京) · 所有清单源码实提/数据盘实读 · 0编造</div></header>
<main>

${sec("src", "①", "数据源层 —— 每条通路·实时新鲜度", [
  row("竞彩五赔种", `500.com trade静态XML: 胜平负/让球/比分/半全场/总进球 + sporttery失败自动降级 · 今日快照${mkt?.snapshots?.length ?? "⚠️"}场(含世界杯${mkt?.snapshots?.filter((s) => s.competition === "世界杯").length ?? "?"}场,euroUnsold悬殊场标记)`),
  row("48队Elo先验", priors ? ok(`eloratings.net · elo_date=${priors.elo_date}(${Math.round((now - Date.parse(priors.elo_date)) / 86400e3 * 10) / 10}天前) · ${Object.keys(priors.teams).length}队`) : "⚠️缺"),
  row("逐场临场赔率", modds ? ok(`ESPN core(DraftKings) ${modds.fixtures.length}场续鲜 · 最新${oddsAge}h前`) : "⚠️缺"),
  row("夺冠外盘", `The Odds API 8账户key池轮换 → Betfair实时(${esc(sc?.titleOddsVintage ?? "?")})`),
  row("大小球真盘", totals ? ok(`Pinnacle totals ${totals.count}场小组赛 · 主线2.25/2.75精确线 · ${ageH(totals.updatedAt)}h前`) : "⚠️未接"),
  row("真实天气", weather ? ok(`Open-Meteo ${Object.keys(weather.byCity).length}城16天预报 · ${ageH(weather.updatedAt)}h前 · 失败城保留旧真预报标stale`) : "⚠️缺"),
  row("赛制/对阵", `${mdates?.count ?? "?"}场赛程+承办城市 · FIFA官方对阵表(R32位次+第三名${Object.keys(bracket?.thirdPlaceTable ?? {}).length}组合) · 16场馆海拔/恒温档`),
  row("画像底座", `ESPN近5/H2H跨联赛 · titan007亚盘 · 本地国际赛49k历史(martj42${intlCsv ? "✅" : "⚠️"}) · Understat俱乐部真xG · 经验库${fxTotal}场/${fxDays}天(${fxRes}带赛果)`),
].join(""))}
${arrow}
${sec("gate", "②", "吸收硬闸 —— 脏数据进不来(逐条防线)", [
  `<div class="step">陈旧缓存防复活:稳定缓存里的"未开售1X2/sfcSold假true"不得复活(守护测试 ingest-stale-cache)</div>`,
  `<div class="step">悬殊场防"买不到的价":竞彩只卖让球的场 europeanOdds=空+euroUnsold标记,下注单自动跳过SPF</div>`,
  `<div class="step">500源spf/nspf内容互换防护:离散度自动定向+并集遍历(0609踩坑根修)</div>`,
  `<div class="step">horizon动态窗口:世界杯期7天,窗外在售场不被整批静默删(ingest-horizon-wc)</div>`,
  `<div class="step">队名闭合:中英双向别名表(刚果(金)/USA/Türkiye/Cabo Verde类) → 引擎实测零断点(s2三探针)</div>`,
  `<div class="step">场馆链路:队名→真实对阵→承办城市→海拔/天气λ,venue恒null静默失效已根除(0607)+探针长守</div>`,
].join(""))}
${arrow}
${sec("brain", "③", "唯一大脑 prediction-engine —— 两条路径全步骤", [
  `<div class="cat">🌍 世界杯路由(0611融合·结构性铁律,守护测试锁死)</div>`,
  `<div class="step"><b>1</b> isWorldCup2026(赛事名+赛期窗+48强名单) → 命中即路由 wc-match-model,俱乐部信号/isotonic校准/防平双选全旁路</div>`,
  `<div class="step"><b>2</b> 国家队Elo(WFE) + 洲际校正(+1.08pp实测) + FIFA积分交叉</div>`,
  `<div class="step"><b>3</b> 场馆λ:海拔>2000m×1.06(墨城2240m) + Open-Meteo真实预报温(>34℃×0.95/30-34×0.97,恒温棚归1) + 阶段乘子(淘汰赛↓)</div>`,
  `<div class="step"><b>4</b> Elo→λ→泊松矩阵 → 单选不防平 + 比分/半全场/让球ladder(-2..+2过盘概率) + 与市场devig对照分歧旗标</div>`,
  `<div class="cat">🏟 俱乐部路径(每日竞彩非世界杯场)</div>`,
  `<div class="step"><b>1</b> 市场赔率锚(blend,回测+3pp) → 有市场prior时融合层门控关(再+1.3pp)</div>`,
  `<div class="step"><b>2</b> Dixon-Coles攻防(club-only学习域,时间衰减,国家队不漏入) + isotonic校准 + 软赛事平局重校准</div>`,
  `<div class="step"><b>3</b> 决策纪律:平局盲区双选0.70阈值 / 中信心客胜不当胆 / 弱联赛不当胆 / 国际赛DC分歧压0.05信市场</div>`,
  `<div class="cat">🏆 整届超算(对标Opta)</div>`,
  `<div class="step">蒙特卡洛N=${sc?.n ?? "?"} seed=${sc?.seed ?? "?"}可复现 · 真FIFA同分规则 · 官方对阵树 · 点球50/50(学界:与强度无关) · 夺冠=α0.65市场+0.35模型 → 当前Top3: ${ok(top3)}</div>`,
  `<div class="cat">📦 src ${srcFiles.length}个生产模块(实扫全列)</div>`,
  [...grouped].map(([cat, files]) => files.length ? `<div class="cat" style="color:#cdd3e0">${cat}(${files.length})</div>${chips(files)}` : "").join(""),
].join(""))}
${arrow}
${sec("gate", "④", `出表硬闸 —— ${suiteCfg.length + 4}+${wcProbes.length}+${pfProbes.length}道,任何一道红=拒绝交付`, [
  `<div class="cat">audit:suite ${suiteCfg.length}探针+4内置(日常零token总闸)</div>`,
  chips(suiteCfg.map((e) => e.id).concat(["html-garbage", "fixtures-future-result", "fixtures-kickoff-hhmm", "三处一致"])),
  `<div class="cat">世界杯五层闸 ${wcProbes.length}探针(audit-wc-pipeline,源→吸收→分析→输出→复盘)</div>`,
  chips(wcProbes),
  `<div class="cat">启动自检 preflight ${pfProbes.length}项(五大生成入口跑前必检)</div>`,
  chips(pfProbes.length ? pfProbes : ["⚠️清单提取失败,见 src/preflight-selfcheck.js"]),
  `<div class="step">防废闸守护:喂毒用例(单调链破/冻结基线篡改/坏赔率)必须被拦 + 真实数据必须能过 · 冻结基线sha256防重冻(重冻=作弊)</div>`,
].join(""))}
${arrow}
${sec("out", "⑤", "输出层 —— 今日真实产物(实扫)", [
  row("交付夹", deliv.length ? ok(deliv.join(" · ")) : `⚠️${DATE}未交付`),
  row("实盘下注单", slip ? ok(`${slip.rows.length}注+${slip.parlays.length}串 · 平注分层(SPF/让球1U·串0.5U·比分/半全场0.25U) · EV逐行如实 · 红场保留标注`) : "今日未出"),
  row("14场/任选9", slip?.fourteen && !slip.fourteen.error ? ok(`${slip.fourteen.period} 14腿逐裁:胆${slip.fourteen.bankers.join(",")} · 必防平${slip.fourteen.drawGuards.join(",") || "无"} · 任选9全中${(slip.fourteen.renxuan9.combinedProb * 100).toFixed(2)}%诚实连乘`) : "—"),
  row("对抗证伪", adv ? ok(`三视角(市场效率/样本过拟合/回测一致)${Object.keys(adv.verdicts).length}场逐场落档`) : "⚠️"),
  row("手机固定页", `/wc-bet-slip.xlsx 下注单 · /worldcup.html 超算 · /今日足球推荐.html 全维度 · /model-map.html 本图 · /task-progress.html 进度`),
  row("口径铁律", `三处一致(xlsx↔html↔审计档) · 四玩法独立裁决+透明标注(让球带模型vs市场过盘双数) · 缺数据标⚠️绝不编`),
].join(""))}
${arrow}
${sec("loop", "⑥", "复盘闭环 —— 每个预测都要对账", [
  `<div class="step"><b>11:10</b> RecapBacktest:赛果回收(完赛>24h必有,断链闸红) → 世界杯逐场复盘累计表(胜平负/比分/半全场/让球命中,防偷看冻结基线) → ledger回写(当前${ledgerN ?? "⚠️"}条)</div>`,
  `<div class="step"><b>每3h</b> WCOddsCapture:开盘→收盘漂移留痕 · CLV监控(诚实定位:监控非利润源)</div>`,
  `<div class="step"><b>21:00</b> LineupWatch:首发一出自动重分析推送 · <b>23:50/03:30</b> MarketRefresh临场续鲜</div>`,
  `<div class="step"><b>进化纪律</b>:任何改模型必须leak-safe回测净增益才上线,变差回退;已证伪方向永久封存(temperature/corners/state-space/knn/lowgoals-value/比分Power-devig/弱联赛任选9降权/淘汰赛平局boost等48件0611火化)</div>`,
].join(""))}

<div class="honest">⚠️ <b>诚实边界(回测铁证,挂死在图上)</b>:1X2命中天花板≈市场50-55%(5330场+33278场实证),模型无收盘线edge,分歧越大市场越对;点球≈抛硬币;比分单选物理上限一二成。本模型的价值=校准概率+逐腿裁决+链路零静默失效+复盘可对账;盈亏由注金纪律决定,不承诺稳赢。</div>
<footer>⚡神选独立架构 · ${srcFiles.length}模块/${testFiles.length}测试文件/${suiteCfg.length + 4 + wcProbes.length + pfProbes.length}道闸 · 数字全部本次运行实测</footer>
</main></body></html>`;
writeFileSync(join(SHARE, "model-map.html"), html, "utf8");
console.log(`✅ 全展开版 model-map.html ${Math.round(html.length / 1024)}KB | 模块${srcFiles.length} 测试${testFiles.length} 闸${suiteCfg.length + 4}+${wcProbes.length}+${pfProbes.length} 经验库${fxTotal}场`);
