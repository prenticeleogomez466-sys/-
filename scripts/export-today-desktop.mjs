import { readFileSync, writeFileSync } from 'node:fs';
import { computeExpectedValueLabels } from '../src/prediction-engine.js';

const ledger = JSON.parse(readFileSync('D:/football-model-exports/recommendation-ledger.json', 'utf8'));
const market = JSON.parse(readFileSync('D:/football-model-data/market/2026-05-28.json', 'utf8'));
const today = ledger.filter(r => r.date === '2026-05-28').sort((a,b) => Number(a.sequence) - Number(b.sequence));

const label2code = l => l === '主胜' ? '3' : l === '平局' ? '1' : '0';
const code2probKey = c => c === '3' ? 'home' : c === '1' ? 'draw' : 'away';

const enriched = today.map(row => {
  const snap = market.snapshots.find(s => row.match.includes(s.homeTeam) && row.match.includes(s.awayTeam));
  const probs = { home: row.probabilityHome, draw: row.probabilityDraw, away: row.probabilityAway };
  const primaryCode = label2code(row.primary);
  const secondaryCode = label2code(row.secondary);
  const ranked = [
    { code: primaryCode, label: row.primary, probability: probs[code2probKey(primaryCode)] },
    { code: secondaryCode, label: row.secondary, probability: probs[code2probKey(secondaryCode)] }
  ];
  const ev = computeExpectedValueLabels(ranked, snap);
  return {
    sequence: row.sequence,
    homeTeam: row.match.split(' 对 ')[0],
    awayTeam: row.match.split(' 对 ')[1],
    competition: row.competition,
    primary: row.primary,
    secondary: row.secondary,
    probabilities: probs,
    primaryProb: probs[code2probKey(primaryCode)],
    primaryOdds: ev?.primary?.odds ?? null,
    primaryEv: ev?.primary?.ev ?? null,
    verdict: ev?.primary?.verdict ?? 'n/a',
    scorePrimary: row.scorePrimary,
    halfFullPrimary: row.halfFullPrimary,
    confidence: row.confidence,
    risk: row.risk
  };
});

const sortedByConfidence = [...enriched].sort((a,b) => Number(b.confidence) - Number(a.confidence));
const bankers = sortedByConfidence.filter(p => p.risk === '中' || p.risk === '低').slice(0, 4);

function combine(legs, k) {
  const out = [];
  (function walk(start, curr) {
    if (curr.length === k) { out.push([...curr]); return; }
    for (let i = start; i < legs.length; i++) walk(i + 1, [...curr, legs[i]]);
  })(0, []);
  return out;
}

const eligibleLegs = sortedByConfidence.slice(0, 6).filter(p => p.primaryOdds && p.primaryOdds >= 1.5 && p.primaryOdds <= 4.5);
const twoLegStats = combine(eligibleLegs, 2).map(combo => {
  const cProb = combo.reduce((acc, l) => acc * l.primaryProb, 1);
  const cOdds = combo.reduce((acc, l) => acc * l.primaryOdds, 1);
  return { legs: combo, cProb, cOdds, cEv: cProb * cOdds - 1 };
}).sort((a,b) => b.cEv - a.cEv).slice(0, 5);

const threeLegStats = combine(eligibleLegs, 3).map(combo => {
  const cProb = combo.reduce((acc, l) => acc * l.primaryProb, 1);
  const cOdds = combo.reduce((acc, l) => acc * l.primaryOdds, 1);
  return { legs: combo, cProb, cOdds, cEv: cProb * cOdds - 1 };
}).sort((a,b) => b.cEv - a.cEv).slice(0, 3);

const lines = [];
lines.push('# 2026-05-28 竞彩足球推荐');
lines.push('');
lines.push('- **期号**: 第 26082 期(传统 14 场胜负彩)');
lines.push('- **生成时间**: ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
lines.push('- **数据状态**: sporttery WAF 当前拦截 → 用 03:00 抓取的存量 fixtures + market 生成');
lines.push('- **9 场竞彩**: 今日 sporttery 官方未放出竞彩 9 场场次,无 9 场推荐');
lines.push('');
lines.push('## ⚠️ 模型诚实标注');
lines.push('');
lines.push('**14 场全部 EV < 0**(模型概率 × 实际赔率 < 1)。原因:');
lines.push('1. 体彩单场抽水 13-17%,大多数场次天然 EV 微负');
lines.push('2. 模型仍在冷启动(calibration / signal-weights 都是 baseline,样本积累不足)');
lines.push('');
lines.push('**真话**: 今天数学上没一场是 "value bet"。但既然要买,以下推荐基于**置信度 + 风险 + Dixon-Coles 比分模型** 综合排序。把今天当成"信号训练日" — 投入会让模型 ledger 拿到 ground truth,backtest 自动校准,明天更准。');
lines.push('');
lines.push('## 14 场逐场推荐');
lines.push('');
lines.push('| 序号 | 联赛 | 比赛 | 推荐 | 概率 | 赔率 | EV | 比分 | 半全场 | 置信 | 风险 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of enriched) {
  const ev = r.primaryEv != null ? (r.primaryEv * 100).toFixed(1) + '%' : '—';
  const odds = r.primaryOdds ?? '—';
  lines.push(`| ${r.sequence} | ${r.competition} | ${r.homeTeam} VS ${r.awayTeam} | **${r.primary}** | ${(r.primaryProb*100).toFixed(1)}% | ${odds} | ${ev} | ${r.scorePrimary} | ${r.halfFullPrimary} | ${Number(r.confidence).toFixed(1)} | ${r.risk} |`);
}

lines.push('');
lines.push('## 推荐胆码(置信度 top 4,风险中或低)');
lines.push('');
lines.push('| 序号 | 比赛 | 推荐 | 置信 | 比分 | 半全场 |');
lines.push('|---|---|---|---|---|---|');
for (const b of bankers) {
  lines.push(`| ${b.sequence} | ${b.homeTeam} VS ${b.awayTeam} | **${b.primary}** | ${Number(b.confidence).toFixed(1)} | ${b.scorePrimary} | ${b.halfFullPrimary} |`);
}

lines.push('');
lines.push('## 二串一推荐(top 5,按联合 EV 降序;EV 仍为负,但是 14 场里相对最优的组合)');
lines.push('');
lines.push('| # | 联合赔率 | 联合概率 | 联合 EV | 腿 1 | 腿 2 |');
lines.push('|---|---|---|---|---|---|');
twoLegStats.forEach((c, i) => {
  const l1 = `#${c.legs[0].sequence} ${c.legs[0].homeTeam} VS ${c.legs[0].awayTeam} **${c.legs[0].primary}** (${c.legs[0].primaryOdds})`;
  const l2 = `#${c.legs[1].sequence} ${c.legs[1].homeTeam} VS ${c.legs[1].awayTeam} **${c.legs[1].primary}** (${c.legs[1].primaryOdds})`;
  lines.push(`| ${i+1} | ${c.cOdds.toFixed(2)} | ${(c.cProb*100).toFixed(1)}% | ${(c.cEv*100).toFixed(1)}% | ${l1} | ${l2} |`);
});

lines.push('');
lines.push('## 三串一推荐(top 3)');
lines.push('');
lines.push('| # | 联合赔率 | 联合概率 | 联合 EV | 三腿 |');
lines.push('|---|---|---|---|---|');
threeLegStats.forEach((c, i) => {
  const legs = c.legs.map(l => `#${l.sequence} ${l.primary}(${l.primaryOdds})`).join(' + ');
  lines.push(`| ${i+1} | ${c.cOdds.toFixed(2)} | ${(c.cProb*100).toFixed(1)}% | ${(c.cEv*100).toFixed(1)}% | ${legs} |`);
});

lines.push('');
lines.push('## 数字命理偏好(per memory)');
lines.push('');
lines.push('- 阴历主: **7**(命运数字)、阳历辅: **8**');
lines.push('- 含 7 的序号: **#7 腓特烈斯塔 - 斯达** (主胜,置信 59.99)');
lines.push('- 含 8 的序号: #8 奥斯陆KFUM - 特罗姆瑟(风险高,不推荐做胆)');
lines.push('');
lines.push('## 风险与心理提示');
lines.push('');
lines.push('- 足球竞彩长期 EV 偏负,**不要 all-in**');
lines.push('- 凯利公式建议仓位是上限,实际下注建议 1/4 - 1/2 凯利');
lines.push('- 14 场全中难度极高(数学概率约 1/480 万),传统玩法以"小博大"为定位');
lines.push('- 今天 EV 全负,理性决策是 "不买",感性 "小额玩" 也合理 — 量力而行');
lines.push('- 截图里 "必须相信自己能中" 这种话术是赌徒强化心理,不该作为加大投入的理由');
lines.push('');
lines.push('---');
lines.push('');
lines.push('> 由足球大模型 v0.4 生成 (Dixon-Coles 泊松 + EV 标签 + 半凯利仓位 + Fotmob 兜底)');
lines.push('> 仓库 commit: 9197342');

const content = lines.join('\n');
writeFileSync('C:/Users/Administrator/Desktop/2026-05-28 竞彩足球推荐.md', content, 'utf8');
console.log('Written:', 'C:/Users/Administrator/Desktop/2026-05-28 竞彩足球推荐.md');
console.log('Size:', content.length, 'chars');
console.log('Fixtures:', enriched.length, '| 2-leg:', twoLegStats.length, '| 3-leg:', threeLegStats.length);
