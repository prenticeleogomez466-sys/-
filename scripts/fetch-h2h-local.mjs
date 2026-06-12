#!/usr/bin/env node
/**
 * fetch-h2h-local.mjs — 用本地 martj42 国际赛结果库补全 2026-06-11 推荐卡 H2H 缺口
 *
 * 数据源: D:\football-model\data\intl-results\results.csv (martj42/international_results, Public Domain, 截至2026-06-03)
 * 输入:   D:\football-model-data\fixtures\2026-06-11.json (14场对阵权威清单)
 * 输出:   D:\football-model-data\coverage\2026-06-11.json (读改写合并, 只新增/更新每场 h2h 字段, 绝不动其他字段)
 *         D:\Temp\wc-rec-0611\h2h-local-2026-06-11.json (全量明细备查)
 *
 * 三标签: 有交锋 => label '✅实测(本地历史库)'; 无交锋 => meetings:[] + summary:null + '⚠️无历史交锋记录'
 * 绝不编造: 全部交锋记录逐行来自 csv, 可按 date+双方队名回溯。
 */
import fs from 'node:fs';
import path from 'node:path';

const CSV_PATH = 'D:/football-model/data/intl-results/results.csv';
// --date 参数化(2026-06-11):原写死 06-11,世界杯期间每日链(run-wc-pro-delivery)按当日跑。
const DATE = (() => { const i = process.argv.indexOf('--date'); const v = i > -1 ? process.argv[i + 1] : (process.argv.find(a => a.startsWith('--date=')) || '').slice(7); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()); })();
const FIXTURES_PATH = `D:/football-model-data/fixtures/${DATE}.json`;
const COVERAGE_PATH = `D:/football-model-data/coverage/${DATE}.json`;
const TEMP_DIR = 'D:/Temp/wc-rec-0611';
const SOURCE_TAG = 'martj42-intl-results-local(截至2026-06-03)';

// 中文队名 -> martj42 results.csv 英文规范名
// 拼写已于 2026-06-10 逐一对 csv 实测验证(South Korea=1214行/Czech Republic=366/Turkey=746/
// Curaçao=432/Ivory Coast=750/United States=1856/Bosnia and Herzegovina=285 等), 运行时再强校验。
const ZH_TO_CSV = {
  '墨西哥': 'Mexico',
  '南非': 'South Africa',
  '韩国': 'South Korea',
  '捷克': 'Czech Republic',
  '加拿大': 'Canada',
  '波黑': 'Bosnia and Herzegovina',
  '美国': 'United States',
  '巴拉圭': 'Paraguay',
  '卡塔尔': 'Qatar',
  '瑞士': 'Switzerland',
  '巴西': 'Brazil',
  '摩洛哥': 'Morocco',
  '海地': 'Haiti',
  '苏格兰': 'Scotland',
  '澳大利亚': 'Australia',
  '土耳其': 'Turkey',
  '德国': 'Germany',
  '库拉索': 'Curaçao',
  '荷兰': 'Netherlands',
  '日本': 'Japan',
  '科特迪瓦': 'Ivory Coast',
  '厄瓜多尔': 'Ecuador',
  '瑞典': 'Sweden',
  '突尼斯': 'Tunisia',
  '葡萄牙': 'Portugal',
  '尼日利亚': 'Nigeria',
  '英格兰': 'England',
  '哥斯达黎加': 'Costa Rica',
  // 2026-06-11 新增 6/16-17 批次8场16队(英文名已逐一对 csv 实测验证存在, 运行时仍强校验)
  '西班牙': 'Spain',
  '佛得角': 'Cape Verde',
  '比利时': 'Belgium',
  '埃及': 'Egypt',
  '沙特阿拉伯': 'Saudi Arabia',
  '乌拉圭': 'Uruguay',
  '伊朗': 'Iran',
  '新西兰': 'New Zealand',
  '法国': 'France',
  '塞内加尔': 'Senegal',
  '伊拉克': 'Iraq',
  '挪威': 'Norway',
  '阿根廷': 'Argentina',
  '阿尔及利亚': 'Algeria',
  '奥地利': 'Austria',
  '约旦': 'Jordan',
  // 2026-06-12 补 6/18 批次缺口3队(csv 实测拼写:Panama/Uzbekistan/Colombia 均在库,合计1632行)
  '巴拿马': 'Panama',
  '乌兹别克斯坦': 'Uzbekistan',
  '哥伦比亚': 'Colombia',
  '加纳': 'Ghana',
  '克罗地亚': 'Croatia',
  '刚果(金)': 'DR Congo',
  '刚果民主共和国': 'DR Congo',
};

// ---------- 最小引号感知 CSV 解析(city 可能含逗号) ----------
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadResults() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  for (const k of ['date', 'home_team', 'away_team', 'home_score', 'away_score', 'tournament', 'city', 'country', 'neutral']) {
    if (!(k in idx)) throw new Error(`csv 缺列 ${k}, 实际表头: ${header.join('|')}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length < 9) continue;
    rows.push({
      date: f[idx.date],
      home: f[idx.home_team],
      away: f[idx.away_team],
      hs: f[idx.home_score] === '' ? null : Number(f[idx.home_score]),
      as: f[idx.away_score] === '' ? null : Number(f[idx.away_score]),
      tournament: f[idx.tournament],
      city: f[idx.city],
      country: f[idx.country],
      neutral: String(f[idx.neutral]).toUpperCase() === 'TRUE',
    });
  }
  return rows;
}

// 🔴硬切线: csv 实测混入 2026-06-11~27 世界杯未来赛程占位行(比分=NA), 绝不能当历史交锋。
// 数据集诚实截至日 2026-06-03, 超过此日期或无有效比分的行一律剔除并单独计数(不兜底不冒充)。
const CUTOFF_DATE = '2026-06-03';

// FIFA 官方承继的前身国(martj42 按旧国名记录): 捷克继承捷克斯洛伐克战绩。
// 本期14场仅捷克涉及(德国在 martj42 中已并为 Germany; 波黑不继承 Yugoslavia, 通行做法不算)。
const PREDECESSORS = { 'Czech Republic': ['Czechoslovakia'] };

function h2hFor(rows, teamA, teamB) {
  // teamA = 本场竞彩主队视角; 前身国名一并匹配, meetings 行保留 csv 原始队名可溯源
  const aNames = new Set([teamA, ...(PREDECESSORS[teamA] || [])]);
  const bNames = new Set([teamB, ...(PREDECESSORS[teamB] || [])]);
  const all = rows.filter(r =>
    (aNames.has(r.home) && bNames.has(r.away)) || (bNames.has(r.home) && aNames.has(r.away)));
  const excluded = all.filter(r => r.date > CUTOFF_DATE
    || r.hs == null || r.as == null || Number.isNaN(r.hs) || Number.isNaN(r.as));
  const meetings = all.filter(r => !excluded.includes(r));
  meetings.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const m of meetings) {
    const aGoals = aNames.has(m.home) ? m.hs : m.as;
    const bGoals = aNames.has(m.home) ? m.as : m.hs;
    gf += aGoals; ga += bGoals;
    if (aGoals > bGoals) w++; else if (aGoals === bGoals) d++; else l++;
  }
  const scored = w + d + l;
  const predecessorRows = meetings.filter(m => m.home !== teamA && m.home !== teamB).length;
  const last10 = meetings.slice(-10).reverse().map(m => {
    const aGoals = aNames.has(m.home) ? m.hs : m.as;
    const bGoals = aNames.has(m.home) ? m.as : m.hs;
    return {
      date: m.date,
      tournament: m.tournament,
      home: m.home,
      away: m.away,
      score: `${m.hs}-${m.as}`,
      neutral: m.neutral,
      venue: `${m.city}, ${m.country}`,
      resForFixtureHome: aGoals > bGoals ? '胜' : aGoals === bGoals ? '平' : '负',
    };
  });
  return {
    meetings, last10, w, d, l, gf, ga, scored, predecessorRows,
    excludedFuture: excluded.map(m => ({ date: m.date, home: m.home, away: m.away, tournament: m.tournament, reason: m.date > CUTOFF_DATE ? '未来赛程占位行(>截至日)' : '无有效比分' })),
  };
}

function main() {
  // 1) 输入
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')).fixtures;
  if (!Array.isArray(fixtures) || !fixtures.length) {
    throw new Error(`fixtures 为空: ${FIXTURES_PATH}(原14场断言已放开——在售窗口场数随期次浮动)`);
  }
  const rows = loadResults();
  console.log(`[load] results.csv 共 ${rows.length} 场国际赛`);

  // 2) 队名映射强校验: 每个映射英文名必须真实出现在 csv
  const nameCount = new Map();
  for (const r of rows) {
    nameCount.set(r.home, (nameCount.get(r.home) || 0) + 1);
    nameCount.set(r.away, (nameCount.get(r.away) || 0) + 1);
  }
  const missing = [];
  for (const fx of fixtures) {
    for (const zh of [fx.homeTeam, fx.awayTeam]) {
      const en = ZH_TO_CSV[zh];
      if (!en) missing.push(`无映射: ${zh}`);
      else if (!nameCount.has(en)) missing.push(`映射名不在csv: ${zh} -> ${en}`);
    }
  }
  if (missing.length) throw new Error('队名映射校验失败(绝不带病写入):\n' + missing.join('\n'));

  // 3) 逐场抽 H2H
  const perMatch = [];
  for (const fx of fixtures) {
    const hZh = fx.homeTeam, aZh = fx.awayTeam;
    const hEn = ZH_TO_CSV[hZh], aEn = ZH_TO_CSV[aZh];
    const r = h2hFor(rows, hEn, aEn);
    const h2h = {
      source: SOURCE_TAG,
      label: r.meetings.length > 0 ? '✅实测(本地历史库)' : '⚠️无历史交锋记录',
      homeEn: hEn,
      awayEn: aEn,
      meetings: r.last10,
      summary: r.meetings.length > 0 ? {
        totalMeetings: r.meetings.length,
        record: `${hZh}视角 ${r.w}胜${r.d}平${r.l}负`,
        w: r.w, d: r.d, l: r.l,
        avgGoalsFor: r.scored ? +(r.gf / r.scored).toFixed(2) : null,
        avgGoalsAgainst: r.scored ? +(r.ga / r.scored).toFixed(2) : null,
        firstMeeting: r.meetings[0].date,
        lastMeeting: r.meetings[r.meetings.length - 1].date,
      } : null,
      note: r.meetings.length > 0
        ? `本地库有效历史交锋${r.meetings.length}场(date≤2026-06-03且有真实比分), meetings仅列最近10场`
          + (r.predecessorRows ? `; 含前身国(FIFA官方承继)交锋${r.predecessorRows}场, 行内保留csv原始队名` : '')
        : '⚠️无历史交锋记录(martj42本地库1872~2026-06-03内零有效交锋, 如实标缺不兜底)',
      fetchedAt: new Date().toISOString(),
    };
    if (r.excludedFuture.length) {
      h2h.excludedRows = r.excludedFuture;
      h2h.excludedNote = `⚠️csv含${r.excludedFuture.length}行未来赛程占位/无比分行已剔除, 不计入历史交锋`;
    }
    perMatch.push({ match: `${hZh} vs ${aZh}`, sequence: fx.sequence, h2h, allMeetings: r.meetings });
  }

  // 4) 合并写 coverage(读改写, 只动 h2h)
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8'));
  if (!Array.isArray(coverage.matches)) throw new Error('coverage.matches 不是数组, 拒绝写入');
  let merged = 0, appended = 0;
  for (const pm of perMatch) {
    const [hZh, aZh] = pm.match.split(' vs ');
    let entry = coverage.matches.find(m =>
      m.match === pm.match || (m.home && m.home.zh === hZh && m.away && m.away.zh === aZh));
    if (entry) { entry.h2h = pm.h2h; merged++; }
    else {
      coverage.matches.push({ match: pm.match, comp: '(coverage原缺此场, 由fetch-h2h-local补入)', h2h: pm.h2h });
      appended++;
    }
  }
  coverage.h2hLocalUpdatedAt = new Date().toISOString();
  coverage.h2hLocalSource = SOURCE_TAG;
  fs.writeFileSync(COVERAGE_PATH, JSON.stringify(coverage, null, 2), 'utf8');
  console.log(`[coverage] 合并写入 ${COVERAGE_PATH}: 命中合并${merged}场, 追加${appended}场`);

  // 5) 全量明细落 Temp 备查
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const detailPath = path.join(TEMP_DIR, 'h2h-local-2026-06-11.json');
  fs.writeFileSync(detailPath, JSON.stringify({
    date: '2026-06-11', source: SOURCE_TAG, generatedAt: new Date().toISOString(),
    matches: perMatch.map(p => ({ match: p.match, sequence: p.sequence, total: p.allMeetings.length, h2h: p.h2h, allMeetings: p.allMeetings })),
  }, null, 2), 'utf8');
  console.log(`[detail] 全量交锋明细 -> ${detailPath}`);

  // 6) 命中清单
  console.log('\n===== 每场 H2H 命中交锋数 =====');
  for (const pm of perMatch) {
    const s = pm.h2h.summary;
    console.log(`${pm.sequence} ${pm.match}: ${pm.allMeetings.length}场` +
      (s ? ` | ${s.record} | 场均 ${s.avgGoalsFor}:${s.avgGoalsAgainst} | 末次 ${s.lastMeeting}` : ' | ⚠️无历史交锋记录'));
  }
}

main();
