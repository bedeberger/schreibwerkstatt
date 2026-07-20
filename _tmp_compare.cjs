'use strict';
const fs=require('fs'), path=require('path'); const { pathToFileURL }=require('url');
const env=fs.readFileSync('.env','utf8').split('\n').reduce((a,l)=>{const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)a[m[1]]=m[2];return a;},{});
const API_KEY=env.CLAUDE_API_KEY, MODEL='claude-sonnet-4-6';
const BOOK_ID=1, PAGE_ID=127, RUNS=3;
const { htmlToText }=require('./routes/jobs/shared/ai');
const { narrativeLabels }=require('./routes/jobs/narrative-labels');
const { getBookSettings, getChapterFigures, getChapterFigureRelations, getChapterLocations }=require('./db/schema');
const Database=require('better-sqlite3'); const rdb=new Database('./schreibwerkstatt.db',{readonly:true});
const OBJ=new Set(['rechtschreibung','grammatik','dialogformat','namenskonsistenz','figurenmerkmal','anrede']);
const norm=s=>(s||'').trim().replace(/\s+/g,' ').toLowerCase(); const key=f=>`${f.typ}|${norm(f.original)}`;
function parseJSON(t){try{return JSON.parse(t);}catch(_){}const s=t.indexOf('{'),e=t.lastIndexOf('}');try{return JSON.parse(t.slice(s,e+1));}catch(_){}const{jsonrepair}=require('jsonrepair');return JSON.parse(jsonrepair(t.slice(s<0?0:s,e>s?e+1:t.length)));}
async function call(sys,user,temp){const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL,max_tokens:16000,temperature:temp,system:sys,messages:[{role:'user',content:user}]})});if(!r.ok)throw new Error(`HTTP ${r.status}: ${await r.text()}`);const j=await r.json();return {txt:(j.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(''),usage:j.usage,stop:j.stop_reason};}
function dedup(arr){const s=new Set();return arr.filter(f=>{const k=`${f.typ}|${f.original}|${f.korrektur}`;if(s.has(k))return false;s.add(k);return true;});}
function stats(runsObj){ // runsObj: array of arrays of objective findings
  const per=runsObj.map(r=>new Set(r.map(key))); const all=new Set(); per.forEach(s=>s.forEach(k=>all.add(k)));
  let in3=0,in1=0; for(const k of all){const c=per.filter(s=>s.has(k)).length; if(c>=RUNS)in3++; if(c===1)in1++;}
  const jac=(a,b)=>{let i=0;for(const k of a)if(b.has(k))i++;const u=new Set([...a,...b]).size;return u?i/u:1;};
  const js=[]; for(let i=0;i<per.length;i++)for(let j=i+1;j<per.length;j++)js.push(jac(per[i],per[j]));
  return {sizes:per.map(s=>s.size), union:all.size, in3, in1, jacAvg:js.reduce((a,b)=>a+b,0)/js.length};
}
(async()=>{
  const mod=await import(pathToFileURL(path.resolve('public/js/prompts.js')).href);
  const cfg=JSON.parse(fs.readFileSync('prompt-config.json','utf8')); mod.configurePrompts(cfg,'claude');
  const bp=mod.getLocalePromptsForBook('de-CH',null,null,false,null,null,false); const SYS=bp.SYSTEM_LEKTORAT_BLOCKS;
  const pr=rdb.prepare('SELECT page_name,chapter_id,body_html FROM pages WHERE page_id=?').get(PAGE_ID);
  const text=htmlToText(pr.body_html);
  const bs=getBookSettings(BOOK_ID,null);
  const figuren=getChapterFigures(BOOK_ID,pr.chapter_id,null), orte=getChapterLocations(BOOK_ID,pr.chapter_id,null), bez=getChapterFigureRelations(BOOK_ID,pr.chapter_id,null);
  const combi=mod.buildLektoratPrompt(text,{stopwords:bp.STOPWORDS,erklaerungRule:bp.ERKLAERUNG_RULE,korrekturRegeln:bp.KORREKTUR_REGELN,figuren,figurenBeziehungen:bez,orte,pageName:pr.page_name,chapterName:null,...narrativeLabels(bs),previousExcerpt:null,langCode:'de'});
  const obj=mod.buildObjektivLektoratPrompt(text,{figuren,figurenBeziehungen:bez,orte,pageName:pr.page_name,chapterName:null,langCode:'de'});
  console.log(`Seite «${pr.page_name}» ${text.length} Zeichen | Kombi-Prompt ${combi.length}c, Objektiv-Prompt ${obj.length}c`);
  console.log(`Baseline=Kombi(temp0.2), Objektiv-Pass(temp0), je ${RUNS} Runs. Vergleich auf OBJEKTIVE Typen.\n`);
  async function series(label,user,temp){const out=[];for(let i=0;i<RUNS;i++){process.stdout.write(`${label} Run ${i+1} ... `);const{txt,usage,stop}=await call(SYS,user,temp);let p;try{p=parseJSON(txt);}catch(e){console.log('PARSE-FAIL');out.push([]);continue;}const fe=dedup((Array.isArray(p.fehler)?p.fehler:[]).map(f=>({typ:(f.typ||'').toLowerCase(),original:f.original,korrektur:f.korrektur})));const objf=fe.filter(f=>OBJ.has(f.typ));console.log(`${fe.length} total, ${objf.length} objektiv | out ${usage?.output_tokens} stop=${stop}`);out.push(objf);}return out;}
  const baseObj=await series('KOMBI',combi,0.2);
  const passObj=await series('OBJEKTIV',obj,0);
  const b=stats(baseObj), o=stats(passObj);
  const line=(n,s)=>`${n.padEnd(22)} pro Run [${s.sizes.join(', ')}]  union ${String(s.union).padStart(3)}  in-alle-${RUNS} ${s.in3} (${s.union?Math.round(s.in3/s.union*100):0}%)  nur-1 ${s.in1} (${s.union?Math.round(s.in1/s.union*100):0}%)  Jaccard ${s.jacAvg.toFixed(2)}`;
  console.log('\n===== OBJEKTIVE FEHLER: Kombi-Prompt vs. Objektiv-Pass =====');
  console.log(line('Kombi-Prompt (0.2)',b));
  console.log(line('Objektiv-Pass (0)',o));
  console.log(`\nRecall-Delta (union distinct objektiv): Kombi ${b.union} → Objektiv ${o.union}  (${o.union-b.union>=0?'+':''}${o.union-b.union}, ${b.union?Math.round((o.union/b.union-1)*100):0}%)`);
  console.log(`Ø Findings pro Einzel-Run: Kombi ${(b.sizes.reduce((a,c)=>a+c,0)/RUNS).toFixed(1)} → Objektiv ${(o.sizes.reduce((a,c)=>a+c,0)/RUNS).toFixed(1)}`);
  // 2er-Union des Objektiv-Passes (zeigt, wieviel ein zweiter Lauf holt)
  const u2=new Set([...passObj[0].map(key),...passObj[1].map(key)]); const u1=new Set(passObj[0].map(key));
  console.log(`Objektiv-Pass Union: 1 Run ${u1.size} → 2 Runs ${u2.size} → 3 Runs ${o.union}`);
})().catch(e=>{console.error(e);process.exit(1);});
