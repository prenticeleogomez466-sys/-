// 抓国家队 Elo 落盘:node scripts/sync-national-elo.mjs(建议每周刷新)。
import { syncNationalElo } from "../src/national-elo-source.js";
const r = await syncNationalElo({ builtAt: new Date().toISOString() });
console.log(JSON.stringify(r));
