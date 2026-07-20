'use strict';
const fs=require('fs'), path=require('path'); const { pathToFileURL }=require('url');
const env=fs.readFileSync('.env','utf8').split('\n').reduce((a,l)=>{const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)a[m[1]]=m[2];return a;},{});
const API_KEY=env.CLAUDE_API_KEY, MODEL='claude-sonnet-4-6';
const { htmlToText }=require('./routes/jobs/shared/ai');
const { getChapterFigures, getChapterFigureRelations, getChapterLocations }=require('./db/schema');
const Database=require('better-sqlite3'); const rdb=new Database('./schreibwerkstatt.db',{readonly:true});
async function call(sys,user,label){const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL,max_tokens:16000,temperature:0.2,system:[{type:'text',text:sys,cache_control:{type:'ephemeral'}}],messages:[{role:'user',content:[{type:'text',text:user,cache_control:{type:'ephemeral'}}]}]})});if(!r.ok)throw new Error(`HTTP ${r.status}: ${await r.text()}`);const j=await r.json();const u=j.usage||{};console.log(`  ${label}: in ${u.input_tokens} cache_read ${u.cache_read_input_tokens||0} cache_create ${u.cache_creation_input_tokens||0}`);return j;}
(async()=>{
  const mod=await import(pathToFileURL(path.resolve('public/js/prompts.js')).href);
  mod.configurePrompts(JSON.parse(fs.readFileSync('prompt-config.json','utf8')),'claude');
  const bp=mod.getLocalePromptsForBook('de-CH',null,null,false,null,null,false); const SYS=bp.SYSTEM_LEKTORAT_BLOCKS;
  const pr=rdb.prepare('SELECT page_name,chapter_id,body_html FROM pages WHERE page_id=127').get();
  const text=htmlToText(pr.body_html);
  const figuren=getChapterFigures(1,pr.chapter_id,null), orte=getChapterLocations(1,pr.chapter_id,null), bez=getChapterFigureRelations(1,pr.chapter_id,null);
  const objPrompt=mod.buildObjektivLektoratPrompt(text,{figuren,figurenBeziehungen:bez,orte,pageName:pr.page_name,langCode:'de'});
  const K=3;
  console.log('STAFFELUNG: erst Lauf 1 abschliessen (primet Cache), dann Lauf 2+3 parallel:');
  await call(SYS, objPrompt, 'Objektiv Lauf 1 (kalt, primet)');
  const rest = await Promise.all([call(SYS,objPrompt,'Objektiv Lauf 2'), call(SYS,objPrompt,'Objektiv Lauf 3')]);
  const totalRead = rest.reduce((a,r)=>a+(r.usage?.cache_read_input_tokens||0),0);
  console.log(`\ncache_read auf Läufen 2+3 gesamt: ${totalRead} ${totalRead>0?'✓ Cache greift':'✗ kein Cache'}`);
})().catch(e=>{console.error(e);process.exit(1);});
