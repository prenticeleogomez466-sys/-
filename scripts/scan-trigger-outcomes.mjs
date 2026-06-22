// 触发桶→真实赛果分布(2026-06-22 用户:触发后最爱出的比分/半全场/大小球·从89k真赛果·非赔率)
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
const all = collectHistoricalMatches(4000).filter((m) => m.marketHistorical && m.homeGoals != null && m.awayGoals != null);
function F(m){const mh=m.marketHistorical,o=mh.openProbs,c=mh.closeProbs;if(!o||!c)return null;
  const fav=c.home>=c.away?"home":"away";const a=mh.asian||{};
  return {fav,fav1x2:c[fav]-o[fav],ou:mh.overProbClose!=null&&mh.overProb!=null?mh.overProbClose-mh.overProb:null,
    lineMove:a.lineClose!=null&&a.line!=null?Math.abs(a.lineClose)-Math.abs(a.line):null,
    hg:m.homeGoals,ag:m.awayGoals,hh:m.halfHome,ha:m.halfAway,
    // 比分按热门视角(强-弱),让平局/比分跨主客可比
    sStrong:fav==="home"?`${m.homeGoals}-${m.awayGoals}`:`${m.awayGoals}-${m.homeGoals}`};}
const R=all.map(F).filter(Boolean);
const top=(arr,key,n=4)=>{const mp={};for(const x of arr){const k=key(x);if(k==null)continue;mp[k]=(mp[k]||0)+1;}
  const t=Object.entries(mp).sort((a,b)=>b[1]-a[1]).slice(0,n);const tot=arr.length;
  return t.map(([k,v])=>`${k}(${Math.round(v/tot*100)}%)`).join(" ");};
const hfStr=x=>{if(x.hh==null||x.ha==null)return null;const h=x.hh>x.ha?"主":x.hh<x.ha?"客":"平";const f=x.hg>x.ag?"主":x.hg<x.ag?"客":"平";
  // 热门视角
  const fav=x.fav==="home";const map={主:fav?"热":"冷",客:fav?"冷":"热",平:"平"};return `${map[h]}-${map[f]}`;};
const overR=arr=>Math.round(arr.filter(x=>x.hg+x.ag>2.5).length/arr.length*100);
function rep(name,filt){const s=R.filter(filt);if(s.length<150){console.log(name,'样本不足('+s.length+')');return;}
  console.log('\n▌'+name+'  (n='+s.length+')');
  console.log('  最爱比分(热门视角强-弱):', top(s,x=>x.sStrong,5));
  console.log('  最爱半全场(热/冷/平):', top(s,x=>hfStr(x),4));
  console.log('  大球率:', overR(s)+'%','｜热门命中:', Math.round(s.filter(x=>(x.hg>x.ag?"home":x.hg<x.ag?"away":"d")===x.fav).length/s.length*100)+'%');}
console.log('=== 触发桶 → 真实赛果最爱出的比分/半全场/大小球(89k场·✅真赛果非赔率)===');
rep('大球盘加注(over收≥初+3%)', x=>x.ou!=null&&x.ou>=0.03);
rep('大球盘退烧(over收≤初-3%)', x=>x.ou!=null&&x.ou<=-0.03);
rep('1X2加注+大球加注(双加注)', x=>x.fav1x2>=0.03&&x.ou!=null&&x.ou>=0.03);
rep('1X2热门加注', x=>x.fav1x2>=0.03);
rep('让球线加深(≥0.25)', x=>x.lineMove!=null&&x.lineMove>=0.25);
rep('全样本基线', ()=>true);
