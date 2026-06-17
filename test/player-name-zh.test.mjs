import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translatePlayer, translatePosition, playerDisplay } from "../src/player-name-zh.js";

describe("球员名/位置中文化(player-name-zh·知名转中文·生僻不瞎音译)", () => {
  it("位置代码→中文(确定性)", () => {
    assert.equal(translatePosition("G"), "门将");
    assert.equal(translatePosition("CD-R"), "右中卫");
    assert.equal(translatePosition("AM-L"), "左前腰");
    assert.equal(translatePosition("F"), "前锋");
    assert.equal(translatePosition("SUB"), "替补");
  });
  it("未知位置码→原样返回(不编)", () => {
    assert.equal(translatePosition("ZZ"), "ZZ");
    assert.equal(translatePosition(""), "");
  });
  it("知名球员→公认中文名", () => {
    assert.equal(translatePlayer("Kylian Mbappé"), "姆巴佩");
    assert.equal(translatePlayer("Cristiano Ronaldo"), "克里斯蒂亚诺·罗纳尔多");
    assert.equal(translatePlayer("Son Heung-Min"), "孙兴慜");
  });
  it("无权威中文名的生僻球员→保留拉丁原名(绝不瞎音译·防编造)", () => {
    assert.equal(translatePlayer("Abduvohid Nematov"), "Abduvohid Nematov");
    assert.equal(translatePlayer("Marko Farji"), "Marko Farji");
  });
  it("playerDisplay=中文名(位置中文)", () => {
    assert.equal(playerDisplay({ name: "Kylian Mbappé", position: "F" }), "姆巴佩(前锋)");
    assert.equal(playerDisplay({ name: "Mike Maignan", position: "G" }), "迈尼昂(门将)");
    // 生僻球员保留原名,位置仍中文
    assert.equal(playerDisplay({ name: "Marko Farji", position: "LB" }), "Marko Farji(左后卫)");
  });
});
