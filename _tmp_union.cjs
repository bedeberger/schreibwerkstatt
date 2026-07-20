'use strict';
const fs=require('fs'), path=require('path'); const { pathToFileURL }=require('url');
const env=fs.readFileSync('.env','utf8').split('\n').reduce((a,l)=>{const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)a[m[1]]=m[2];return a;},{});
const API_KEY=env.CLAUDE_API_KEY, MODEL='claude-sonnet-4-6';
const BOOK_ID=1, PAGE_ID=127, RUNS=4, TEMP=0.7;
const { htmlToText }=require('./routes/jobs/shared/ai');
const { getChapterFigures, getChapterFigureRelations, getChapterLocations }=require('./db/schema');
const Database=require('better-sqlite3'); const rdb=new Database('./schreibwerkstatt.db',{readonly:true});
const norm=s=>(s||'').trim().replace(/\s+/g,' ').toLowerCase(); const key=f=>`${f.typ}|${norm(f.original)}`;
function parseJSON(t){try{return JSON.parse(t);}catch(_){}const s=t.indexOf('{'),e=t.lastIndexOf('}');try{return JSON.parse(t.slice(s,e+1));}catch(_){}const{jsonrepair}=require('jsonrepair');return JSON.parse(jsonrepair(t.slice(s<0?0:s,e>s?e+1:t.length)));}
async function call(sys,user,temp){const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL,max_tokens:16000,temperature:temp,system:sys,messages:[{role:'user',content:user}]})});if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();return {txt:(j.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(''),out:j.usage?.output_tokens};}
function dedup(a){const s=new Set();return a.filter(f=>{const k=`${f.typ}|${f.original}|${f.korrektur}`;if(s.has(k))return false;s.add(k);return true;});}
(async()=>{
  const mod=await import(pathToFileURL(path.resolve('public/js/prompts.js')).href);
  const cfg=JSON.parse(fs.readFileSync('prompt-config.json','utf8')); mod.configurePrompts(cfg,'claude');
  const bp=mod.getLocalePromptsForBook('de-CH',null,null,false,null,null,false); const SYS=bp.SYSTEM_LEKTORAT_BLOCKS;
  const pr=rdb.prepare('SELECT page_name,chapter_id,body_html FROM pages WHERE page_id=?').get(PAGE_ID);
  const text=htmlToText(pr.body_html);
  const figuren=getChapterFigures(BOOK_ID,pr.chapter_id,null), orte=getChapterLocations(BOOK_ID,pr.chapter_id,null), bez=getChapterFigureRelations(BOOK_ID,pr.chapter_id,null);
  const user=mod.buildObjektivLektoratPrompt(text,{figuren,figurenBeziehungen:bez,orte,pageName:pr.page_name,langCode:'de'});
  console.log(`Objektiv-Pass, temp ${TEMP}, ${RUNS} Runs — kumulatives Union-Wachstum:\n`);
  const runs=[]; let totalOut=0;
  const cum=new Set();
  for(let i=0;i<RUNS;i++){process.stdout.write(`Run ${i+1} ... `);const{txt,out}=await call(SYS,user,TEMP);totalOut+=out||0;let p;try{p=parseJSON(txt);}catch(e){console.log('FAIL');runs.push([]);continue;}const fe=dedup((Array.isArray(p.fehler)?p.fehler:[]).map(f=>({typ:(f.typ||'').toLowerCase(),original:f.original,korrektur:f.korrektur})));runs.push(fe);const before=cum.size;fe.forEach(f=>cum.add(key(f)));console.log(`${fe.length} findings | union nach ${i+1} Runs: ${cum.size} (+${cum.size-before} neu) | out ${out}`);}
  // Stabilität
  const per=runs.map(r=>new Set(r.map(key)));
  let inAll=0; for(const k of cum){if(per.every(s=>s.has(k)))inAll++;}
  console.log(`\nUnion total (4 Runs): ${cum.size} | in allen 4: ${inAll} (${Math.round(inAll/cum.size*100)}%)`);
  console.log(`Output-Tokens gesamt (4 Runs): ${totalOut} (Ø ${Math.round(totalOut/RUNS)}/Run) — vgl. EIN Kombi-Run ~9000`);
})().catch(e=>{console.error(e);process.exit(1);});
