// fetch-asian-titan007.mjs — 球探/新球体育(titan007)竞彩亚盘+欧赔百家平均抓取(可复用)
//
// 数据通路(2026-06-10 实证):
//   1) 赛程清单: http://jc.titan007.com/xml/bf_jc.txt
//      格式: 联赛区$记录1!记录2!...  每条记录 ^ 分隔, [0]=scheduleID [4]=周X编号 [8]=主队ID
//            [9]=主队名(简,繁,竞彩) [10]=客队ID [11]=客队名 ...
//   2) 亚盘详情(静态HTML可直接解析): http://vip.titan007.com/AsianOdds_n.aspx?id=<scheduleID>
//      每家公司主行含 name="oddsShow" checkbox; 初盘=3个带 title 属性的td(主水/盘口/客水),
//      即时盘=3个 oddstype="wholeLastOdds" 的td; 盘口td带 goals 属性(>0=主让, <0=主受让)。
//   3) 欧赔(1X2)数据JS: http://1x2d.titan007.com/<scheduleID>.js
//      var game=Array("cid|oddsid|公司名|初主|初平|初客|...4列概率|即主|即平|即客|...")
//      即时赔率取字段 [10],[11],[12]; 百家平均=全公司均值。
//
// 用法:
//   node scripts/fetch-asian-titan007.mjs --date 2026-06-11 \
//     [--fixtures D:\football-model-data\fixtures\2026-06-11.json] \
//     [--seq 6005,6006]            只抓这些竞彩编号(默认=fixtures里全部)
//     [--euro 3202,6005,7009]      这些编号额外抓欧赔百家平均
//     [--out D:\Temp\out.json]
//
// 输出 JSON: { fetchedAt, source, matches:[{sequence,home,away,scheduleID,asian:{...}|null,euroAvg:{...}|null,error?}] }
// 铁律: 抓不到=null+error 说明, 绝不兜底编造。

import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function arg(name, def) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function get(url, referer) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

// ---------- 赛程清单 ----------
async function fetchScheduleList() {
  const raw = await get('http://jc.titan007.com/xml/bf_jc.txt?' + Date.now(), 'http://jc.titan007.com/');
  const body = raw.includes('$') ? raw.slice(raw.indexOf('$') + 1) : raw;
  const out = [];
  for (const rec of body.split('!')) {
    const f = rec.split('^');
    if (f.length < 12 || !/^\d+$/.test(f[0])) continue;
    out.push({
      scheduleID: f[0],
      weekLabel: f[4],                       // 如 周四001
      home: (f[8] || '').split(',')[0],      // 简体名 (f[7]=主队ID, f[8]=主队名, f[9]=客队ID, f[10]=客队名)
      away: (f[10] || '').split(',')[0],
    });
  }
  return out;
}

// 竞彩编号 "4001"→周四001, "3202"→周三202(国际赛201/202段也按数字尾段匹配)
const WEEK_CN = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
function seqToWeekLabel(seq) {
  const s = String(seq);
  return WEEK_CN[Number(s[0])] + s.slice(1);
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// ---------- 亚盘解析 ----------
function parseAsianPage(html) {
  const companies = [];
  const blocks = html.split(/<tr\b/).slice(1);
  for (const b of blocks) {
    if (!b.includes('name="oddsShow"')) continue; // 只取每家公司的主行(多盘行跳过)
    const idM = b.match(/data-id="(\d+)"/);
    const tds = [...b.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(m => ({ attrs: m[1], text: stripTags(m[2]) }));
    const nameTd = tds.find(t => /height="25"/.test(t.attrs));
    const initTds = tds.filter(t => /title="/.test(t.attrs)).slice(0, 3);
    const liveTds = tds.filter(t => /oddstype="wholeLastOdds"/.test(t.attrs)).slice(0, 3);
    const goalsOf = td => { const m = (td?.attrs || '').match(/goals="(-?[\d.]+)"/); return m ? Number(m[1]) : null; };
    const numOf = td => { const v = Number(td?.text); return Number.isFinite(v) ? v : null; };
    if (initTds.length < 3 && liveTds.length < 3) continue;
    companies.push({
      companyID: idM ? idM[1] : null,
      company: nameTd ? nameTd.text : null,   // 站方打码名,如 澳*/Crow*
      init: initTds.length === 3 ? { homeWater: numOf(initTds[0]), line: goalsOf(initTds[1]), lineText: initTds[1].text, awayWater: numOf(initTds[2]) } : null,
      live: liveTds.length === 3 ? { homeWater: numOf(liveTds[0]), line: goalsOf(liveTds[1]), lineText: liveTds[1].text, awayWater: numOf(liveTds[2]) } : null,
    });
  }
  return companies;
}

async function fetchAsian(scheduleID) {
  const html = await get(`http://vip.titan007.com/AsianOdds_n.aspx?id=${scheduleID}`, 'http://jc.titan007.com/');
  const companies = parseAsianPage(html);
  if (!companies.length) throw new Error('亚盘页解析0家公司(页面结构变了?)');
  // 主参考盘优先级: 皇冠(3) > 澳门(1) > Bet365(8) > 第一家
  const pick = ['3', '1', '8'].map(id => companies.find(c => c.companyID === id)).find(Boolean) || companies[0];
  return { lineConvention: 'line>0=主队让球, line<0=主队受让', primary: pick, companiesCount: companies.length, companies };
}

// ---------- 欧赔百家平均 ----------
async function fetchEuroAvg(scheduleID) {
  const js = await get(`http://1x2d.titan007.com/${scheduleID}.js?r=007${Date.now()}`, `http://1x2.titan007.com/oddslist/${scheduleID}.htm`);
  const gm = js.match(/var game=Array\(([\s\S]*?)\);/);
  if (!gm) throw new Error('1x2d 数据无 game 数组');
  const rows = [...gm[1].matchAll(/"([^"]+)"/g)].map(m => m[1].split('|'));
  const cur = rows
    .map(f => ({ name: f[2], h: Number(f[10]), d: Number(f[11]), a: Number(f[12]) }))
    .filter(r => r.h > 1 && r.d > 1 && r.a > 1);
  if (!cur.length) throw new Error('1x2d 无有效即时赔率行');
  const avg = k => Number((cur.reduce((s, r) => s + r[k], 0) / cur.length).toFixed(3));
  return { home: avg('h'), draw: avg('d'), away: avg('a'), companies: cur.length, sample: cur.slice(0, 3).map(r => `${r.name}:${r.h}/${r.d}/${r.a}`) };
}

// ---------- 主流程 ----------
async function main() {
  const date = arg('date');
  if (!date) { console.error('用法: node fetch-asian-titan007.mjs --date YYYY-MM-DD [--seq ..] [--euro ..] [--out ..]'); process.exit(1); }
  const fixturesPath = arg('fixtures', `D:\\football-model-data\\fixtures\\${date}.json`);
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')).fixtures || [];
  const seqFilter = arg('seq', '') ? arg('seq', '').split(',').map(s => s.trim()) : null;
  const euroSeqs = arg('euro', '') ? arg('euro', '').split(',').map(s => s.trim()) : [];

  const schedule = await fetchScheduleList();
  const result = { fetchedAt: new Date().toISOString(), source: 'jc.titan007.com / vip.titan007.com / 1x2d.titan007.com (球探·新球体育)', date, matches: [] };

  for (const fx of fixtures) {
    const seq = String(fx.sequence);
    if (seqFilter && !seqFilter.includes(seq)) continue;
    const entry = { sequence: seq, home: fx.homeTeam, away: fx.awayTeam, scheduleID: null, asian: null, euroAvg: null, errors: [] };
    // 按 周X+尾三位 + 队名双锚 匹配,防错位
    const wl = seqToWeekLabel(seq);
    const cand = schedule.find(s => s.weekLabel === wl) || null;
    const nameOk = c => c && (c.home === fx.homeTeam || fx.homeTeam.startsWith(c.home) || c.home.startsWith(fx.homeTeam))
      && (c.away === fx.awayTeam || fx.awayTeam.startsWith(c.away) || c.away.startsWith(fx.awayTeam));
    const m = nameOk(cand) ? cand : schedule.find(s => nameOk(s));
    if (!m) { entry.errors.push(`titan007 清单未找到 ${wl} ${fx.homeTeam}vs${fx.awayTeam}`); result.matches.push(entry); continue; }
    entry.scheduleID = m.scheduleID;
    entry.titanLabel = m.weekLabel;
    try { entry.asian = await fetchAsian(m.scheduleID); } catch (e) { entry.errors.push('亚盘: ' + e.message); }
    if (euroSeqs.includes(seq)) {
      try { entry.euroAvg = await fetchEuroAvg(m.scheduleID); } catch (e) { entry.errors.push('欧赔: ' + e.message); }
    }
    result.matches.push(entry);
    await new Promise(r => setTimeout(r, 400)); // 礼貌限速
  }

  const out = arg('out');
  const json = JSON.stringify(result, null, 2);
  if (out) { fs.writeFileSync(out, json); console.error('written: ' + out); }
  else console.log(json);
  const got = result.matches.filter(m => m.asian).length;
  console.error(`亚盘 ${got}/${result.matches.length} 场; 欧赔 ${result.matches.filter(m => m.euroAvg).length}/${euroSeqs.length} 场`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
