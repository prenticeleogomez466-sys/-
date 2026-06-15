// 守护:wc-national-form 的 recentForm/headToHead 必须按 canonicalTeamName 归一匹配。
// 复发根因(2026-06-14 "情报近期赛全空"):缓存按英文名(homeEn="Germany")存,交付传中文规范名("德国")
//   直接 === 比对全 miss → 近期/热身赛列恒空。两侧过 canonicalTeamName 后中/英任一形式都要命中。
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentForm, headToHead } from "../src/wc-national-form.js";
import { englishTeamName } from "../src/team-aliases.js";

const cache = {
  matches: [
    { date: "2026-06-06", homeEn: "United States", awayEn: "Germany", homeGoals: 1, awayGoals: 2, home: "美国", away: "德国" },
    { date: "2026-05-31", homeEn: "Germany", awayEn: "Finland", homeGoals: 4, awayGoals: 0, home: "德国", away: "芬兰" },
    { date: "2026-03-30", homeEn: "Germany", awayEn: "Japan", homeGoals: 2, awayGoals: 1, home: "德国", away: "日本" },
  ],
};

test("recentForm 用中文名也能命中英文缓存(canonical 归一)", () => {
  const zh = recentForm(cache, "德国");
  const en = recentForm(cache, "Germany");
  assert.ok(zh, "中文名应命中");
  assert.equal(zh.played, 3);
  assert.equal(zh.record, "3胜0平0负");
  assert.deepEqual(zh.record, en?.record, "中/英查询结果一致");
});

test("recentForm 无样本队 → null(标缺不编)", () => {
  assert.equal(recentForm(cache, "巴西"), null);
});

test("headToHead 中文名命中英文缓存", () => {
  const h = headToHead(cache, "德国", "日本");
  assert.ok(h);
  assert.equal(h.played, 1);
});

test("englishTeamName 反查:今日 8 队都有英文别名(GDELT 检索用)", () => {
  for (const t of ["德国", "库拉索", "荷兰", "日本", "科特迪瓦", "厄瓜多尔", "瑞典", "突尼斯"]) {
    assert.ok(englishTeamName(t), `${t} 应有英文别名`);
  }
});
