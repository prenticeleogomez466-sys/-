/**
 * Profile Registry 统一 runtime profile 管理
 * ──────────────────────────────────────────────────
 * 启动时一次性加载所有 profile,各模块按需读取:
 *   - referee profiles (fitRefereeProfiles 输出)
 *   - manager profiles (fitManagerProfiles 输出)
 *   - derby pairs (registerDerby)
 *   - set-piece profiles (computeSetPieceProfile)
 *   - formation matchups (fitFormationMatchups)
 *   - team graph embedding (buildTeamGraphEmbedding)
 *   - league baselines (homeWinRate etc.)
 *
 * 单例 + lazy load,模块化解耦.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const PROFILE_DIR = join(getExportDir(), "profiles");

class ProfileRegistry {
  constructor() {
    this.profiles = new Map();
    this.metadata = new Map();
  }

  set(name, profile, meta = {}) {
    this.profiles.set(name, profile);
    this.metadata.set(name, { ...meta, registeredAt: new Date().toISOString() });
  }

  get(name) {
    return this.profiles.get(name);
  }

  has(name) {
    return this.profiles.has(name);
  }

  list() {
    return [...this.profiles.keys()].map((name) => ({
      name,
      meta: this.metadata.get(name) ?? {}
    }));
  }

  /**
   * Convenience accessors for common profiles.
   */
  getRefereeProfiles() { return this.profiles.get("referee") ?? {}; }
  getManagerProfiles() { return this.profiles.get("manager") ?? {}; }
  getSetPieceProfiles() { return this.profiles.get("setPiece") ?? {}; }
  getFormationMatchups() { return this.profiles.get("formationMatchup") ?? {}; }
  getTeamGraphEmbedding() { return this.profiles.get("teamGraph") ?? null; }
  getLeagueBaselines() { return this.profiles.get("leagueBaselines") ?? {}; }

  /**
   * 持久化:把所有 profile 写到磁盘(每个一个 JSON).
   */
  persist() {
    mkdirSync(PROFILE_DIR, { recursive: true });
    for (const [name, profile] of this.profiles.entries()) {
      const path = join(PROFILE_DIR, `${name}.json`);
      writeFileSync(path, JSON.stringify({
        meta: this.metadata.get(name) ?? {},
        profile
      }, null, 2), "utf8");
    }
    return { dir: PROFILE_DIR, count: this.profiles.size };
  }

  /**
   * 从磁盘恢复.
   */
  load(names = null) {
    if (!existsSync(PROFILE_DIR)) return { loaded: 0, missing: PROFILE_DIR };
    const toLoad = names ?? ["referee", "manager", "setPiece", "formationMatchup", "teamGraph", "leagueBaselines"];
    let loaded = 0;
    for (const name of toLoad) {
      const path = join(PROFILE_DIR, `${name}.json`);
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        this.profiles.set(name, data.profile);
        this.metadata.set(name, data.meta);
        loaded++;
      } catch {
        // skip corrupted
      }
    }
    return { loaded, total: toLoad.length };
  }

  clear() {
    this.profiles.clear();
    this.metadata.clear();
  }
}

// 单例
let _instance = null;
export function getProfileRegistry() {
  if (!_instance) _instance = new ProfileRegistry();
  return _instance;
}

// 测试 hook
export function __resetProfileRegistryForTests() {
  _instance = null;
}
