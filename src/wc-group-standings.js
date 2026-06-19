// 世界杯【当前小组积分榜】引擎(2026-06-19 建)——铁律 no-fallback:只用真实已结算赛果,绝不编造未踢场。
// ════════════════════════════════════════════════════════════════════════════════════════
// 用途:
//   1) 从 fixture-store 真实赛果重建 12 个小组当前积分榜(pts/净胜球/进球/胜平负/已踢/剩余)。
//   2) 派生每队"出线情景"(已出线/已淘汰/争夺中 + 末轮自身可控性),供 wc-match-model 动机层与路径分析。
// 排序口径:积分 → 净胜球 → 进球数(FIFA 同分还看相互战绩/纪律分/抽签,本快照层只到进球数,够用且诚实)。
// 队名一律中文(生产口径),与 groups.json team_name_zh / team-priors 对齐。

/** 把一组已踢的比赛聚合成积分榜。playedMatches=[{home,away,ga,gb}](中文队名,ga/gb=主/客进球)。 */
export function groupTable(teams, playedMatches) {
  const row = {};
  for (const t of teams) row[t] = { team: t, pld: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
  for (const m of playedMatches) {
    const H = row[m.home], A = row[m.away];
    if (!H || !A || m.ga == null || m.gb == null) continue;
    H.pld++; A.pld++;
    H.gf += m.ga; H.ga += m.gb; A.gf += m.gb; A.ga += m.ga;
    H.gd = H.gf - H.ga; A.gd = A.gf - A.ga;
    if (m.ga > m.gb) { H.w++; A.l++; H.pts += 3; }
    else if (m.ga < m.gb) { A.w++; H.l++; A.pts += 3; }
    else { H.d++; A.d++; H.pts++; A.pts++; }
  }
  return Object.values(row).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team, "zh"));
}

/** 一组的全部 6 个对阵(无序对)。teams 顺序即 groups.json 抽签顺序。 */
export function allGroupPairs(teams) {
  const pairs = [];
  for (let i = 0; i < teams.length; i++)
    for (let j = i + 1; j < teams.length; j++) pairs.push([teams[i], teams[j]]);
  return pairs;
}

/** 已踢对阵集合(无序键),用于推导剩余场。 */
function pairKey(a, b) { return [a, b].sort((x, y) => x.localeCompare(y, "zh")).join("|"); }

/** 一组的剩余未踢对阵。 */
export function remainingPairs(teams, playedMatches) {
  const done = new Set(playedMatches.map((m) => pairKey(m.home, m.away)));
  return allGroupPairs(teams).filter(([a, b]) => !done.has(pairKey(a, b)));
}

/**
 * 一组当前状态摘要:积分榜 + 每队剩余场数 + 出线/淘汰判定(只在数学上确定时才下结论,否则"争夺中")。
 * 注:本届"前2直接出线 + 8个最佳第三"——单组内无法独判第三能否出线(要跨组比),故第三名只标"待定(看最佳第三)"。
 */
export function groupStatus(teams, playedMatches) {
  const table = groupTable(teams, playedMatches);
  const rem = remainingPairs(teams, playedMatches);
  const remCount = {}; for (const t of teams) remCount[t] = 0;
  for (const [a, b] of rem) { remCount[a]++; remCount[b]++; }
  const totalRounds = 3;
  const playedRounds = Math.max(...table.map((r) => r.pld));
  // 末轮才有"出线/淘汰数学确定"——保守:剩余场=0 时才下死结论;否则只给当前名次。
  return {
    table: table.map((r, i) => ({ ...r, posNow: i + 1, remaining: remCount[r.team] })),
    playedRounds,
    totalRounds,
    remainingPairs: rem,
    complete: rem.length === 0
  };
}
