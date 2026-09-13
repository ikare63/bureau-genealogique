/* Lénaïc Ecosystem Integration v2 — adaptateur léger par application. */
(function(){
'use strict';
if(!window.LenaicEcosystem)return;
const APP=LenaicEcosystem.source();
const CONTEXT_APPS=new Set(['arboris','pistoria','ariane']);
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const read=(key,fallback=null)=>{try{const v=JSON.parse(localStorage.getItem(key)||'null');return v??fallback}catch{return fallback}};
const val=(o,path)=>String(path).split('.').reduce((a,k)=>a?.[k],o);
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function injectStyle(){if($('#lenaicEcosystemStyle'))return;const s=document.createElement('style');s.id='lenaicEcosystemStyle';s.textContent=`
.eco-context-bar{margin:10px auto;padding:10px 12px;max-width:1180px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 5%,transparent);display:flex;align-items:center;gap:10px;flex-wrap:wrap;font:600 13px/1.35 system-ui,-apple-system,sans-serif}.eco-context-bar strong{font-weight:900}.eco-context-bar small{opacity:.72}.eco-context-spacer{flex:1}.eco-context-bar button,.eco-context-bar a,.eco-context-action{border:1px solid currentColor;border-radius:999px;padding:6px 9px;background:transparent;color:inherit;text-decoration:none;font:700 12px/1 system-ui,-apple-system,sans-serif;cursor:pointer}.eco-context-action{margin-left:4px}.eco-context-bar .eco-primary{background:currentColor}.eco-context-bar .eco-primary span{filter:invert(1)}.eco-result-inbox{margin:10px auto;max-width:1180px;padding:10px 12px;border:1px solid #d69a22;border-radius:12px;background:rgba(214,154,34,.08);font:600 13px/1.35 system-ui,-apple-system,sans-serif}.eco-result-inbox strong{display:block;margin-bottom:5px}.eco-result-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.eco-result-actions button{border:1px solid currentColor;border-radius:999px;padding:6px 9px;background:transparent;color:inherit;font:700 12px/1 system-ui,-apple-system,sans-serif;cursor:pointer}
@media(max-width:680px){.eco-context-bar{margin:8px 10px}.eco-context-bar .eco-context-spacer{display:none}.eco-context-bar{align-items:flex-start}.eco-context-bar .eco-context-copy{flex:1 1 70%}}
`;document.head.appendChild(s)}

function recordActivity(){
 const key='lenaic-app-activity-v1',d=read(key,{version:1,apps:{}});d.apps=d.apps||{};d.apps[APP]={app:APP,path:location.pathname,openedAt:d.apps[APP]?.openedAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};localStorage.setItem(key,JSON.stringify(d));
}
recordActivity();setInterval(recordActivity,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)recordActivity()});

function personName(p){return [p?.firstNames||p?.givenNames||p?.firstName||'',p?.lastName||p?.surname||p?.name||''].filter(Boolean).join(' ').replace(/\s+/g,' ').trim()||p?.person||p?.title||'Personne'}
function dateText(v){return typeof v==='string'?v:(v?.date||v?.yearOnly||v?.approximateDate||'')}

function buildSearchIndex(){
 try{
  let items=[];
  if(APP==='arboris'){
   const d=read('memoire-famille-data',{});items=(d.people||[]).map(p=>({id:p.id,type:'person',label:personName(p),subtitle:[p.sosa?`Sosa ${p.sosa}`:'',dateText(p.birth),dateText(p.death),p.branch||''].filter(Boolean).join(' · '),url:`/bureau-genealogique/index.html?person=${encodeURIComponent(p.id)}`,keywords:[p.branch,p.profession,p.occupation,val(p,'birth.commune'),val(p,'death.commune'),val(p,'birth.place'),val(p,'death.place')].filter(Boolean),meta:{sosa:p.sosa||null,personId:p.id}}));
  }else if(APP==='scriptoria'){
   const d=read('scriptoria-data',{});const people=(d.people||[]).map(p=>({id:`p:${p.id}`,type:'person',label:personName(p),subtitle:[p.birthDate||p.baptismDate||'',p.birthPlace||p.residence||'',p.mainOccupation||''].filter(Boolean).join(' · '),url:`/bureau-genealogique/index2.html?search=${encodeURIComponent(personName(p))}`,keywords:[p.mainOccupation,p.otherOccupations,p.residence,p.birthPlace,p.deathPlace].filter(Boolean),meta:{personId:p.id}}));
   const records=(d.records||[]).slice(-2200).map(r=>({id:`r:${r.id}`,type:'record',label:r.title||r.fields?.name||r.fields?.names||r.type||'Acte',subtitle:[r.date||r.year||'',r.commune||r.parish||'',r.pageNumber?`p. ${r.pageNumber}`:''].filter(Boolean).join(' · '),url:`/bureau-genealogique/index2.html?search=${encodeURIComponent(r.title||r.fields?.name||r.fields?.names||r.date||'acte')}`,keywords:[r.transcription,r.registerId,r.recordNumber,r.locality,...Object.values(r.fields||{}).filter(x=>typeof x==='string')].filter(Boolean),meta:{recordId:r.id}}));items=[...people,...records];
  }else if(APP==='pistoria'){
   const d=read('pistoria_private_v3',{});items=(d.investigations||[]).map(inv=>({id:inv.id,type:'investigation',label:inv.person||inv.title||'Enquête Pistoria',subtitle:[inv.sosa!=null?`Sosa ${inv.sosa}`:'',inv.status||'',(inv.steps||[]).find(s=>s.status==='todo')?.title||''].filter(Boolean).join(' · '),url:`/bureau-genealogique/index3.html?investigation=${encodeURIComponent(inv.id)}`,keywords:[inv.title,inv.objective,inv.known,inv.place,...(inv.steps||[]).map(s=>`${s.title||''} ${s.place||''} ${s.period||''}`)].filter(Boolean),meta:{sosa:inv.sosa??null,personId:inv.personId||inv.arborisPersonId||'',investigationId:inv.id}}));
  }else if(APP==='ariane'){
   const d=read('ariane-local-v2',{});items=(d.cases||[]).map(c=>({id:c.id,type:'case',label:c.title||'Enquête Ariane',subtitle:[c.status,c.place,c.date].filter(Boolean).join(' · '),url:`/aide_archive/Ariane.html?case=${encodeURIComponent(c.id)}`,keywords:[c.goal,c.notes,c.type,...(c.items||[]).map(i=>`${i.label||''} ${i.cote||''} ${i.dossier||''}`)].filter(Boolean),meta:{caseId:c.id,personId:c.contextPersonId||''}}));
  }else if(APP==='scribe'){
   const d=read('scribe-local-v3',{});items=(d.drafts||[]).map(x=>({id:x.id,type:'request',label:x.title||'Requête Scribe',subtitle:[x.status,x.fields?.names||x.fields?.people||x.fields?.person1||'',x.fields?.place||x.fields?.commune||''].filter(Boolean).join(' · '),url:`/aide_archive/Scribe-v3.html?draft=${encodeURIComponent(x.id)}`,keywords:[...Object.values(x.fields||{}).filter(v=>typeof v==='string'),x.extra,x.customSubject].filter(Boolean),meta:{draftId:x.id}}));
  }
  if(items.length||['arboris','scriptoria','pistoria','ariane','scribe'].includes(APP))LenaicSearch.publish(APP,items);
 }catch(e){console.warn('Index écosystème',APP,e)}
}
let lastSearchRaw='';function maybeIndex(){const key={arboris:'memoire-famille-data',scriptoria:'scriptoria-data',pistoria:'pistoria_private_v3',ariane:'ariane-local-v2',scribe:'scribe-local-v3'}[APP];if(!key)return;const raw=localStorage.getItem(key)||'';if(raw===lastSearchRaw)return;lastSearchRaw=raw;buildSearchIndex()}
maybeIndex();setInterval(maybeIndex,5000);

function contextBar(){
 if(!CONTEXT_APPS.has(APP))return null;injectStyle();let bar=$('#ecoContextBar');if(!bar){bar=document.createElement('div');bar.id='ecoContextBar';bar.className='eco-context-bar';const anchor=$('header')||$('.app header')||document.body.firstElementChild;anchor?.insertAdjacentElement('afterend',bar)}
 const c=LenaicContext.get();if(!c){bar.innerHTML=`<div class="eco-context-copy"><strong>CONTEXTE GÉNÉALOGIQUE</strong><br><small>Aucune personne active.</small></div><span class="eco-context-spacer"></span>${APP==='arboris'?'<small>Choisis « Contexte » sur une fiche individu.</small>':''}`;return bar}
 const links={arboris:`/bureau-genealogique/index.html?person=${encodeURIComponent(c.personId||'')}`,pistoria:'/bureau-genealogique/index3.html',ariane:'/aide_archive/Ariane.html'};
 bar.innerHTML=`<div class="eco-context-copy"><strong>CONTEXTE ACTIF · ${esc(c.name||'Personne')}</strong><br><small>${c.sosa!=null?`Sosa ${esc(c.sosa)} · `:''}${esc(c.birth||'')}${c.death?` – ${esc(c.death)}`:''}</small></div><span class="eco-context-spacer"></span><a href="${links[APP]}">OUVRIR</a>${APP==='ariane'?'<button type="button" id="ecoCreateAriane">+ DOSSIER POUR CETTE PERSONNE</button>':''}<button type="button" id="ecoClearContext">EFFACER</button>`;
 $('#ecoClearContext',bar)?.addEventListener('click',()=>LenaicContext.clear());
 $('#ecoCreateAriane',bar)?.addEventListener('click',createArianeFromContext);
 return bar;
}
function createArianeFromContext(){
 if(APP!=='ariane')return;const c=LenaicContext.get();if(!c)return;
 try{
  if(typeof state==='undefined'||!Array.isArray(state.cases))return;
  const existing=state.cases.find(x=>x.contextPersonId&&x.contextPersonId===c.personId);
  if(existing){state.activeId=existing.id;save();render();return}
  const id=(globalThis.crypto?.randomUUID?.()||`id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dossier={id,title:`Recherche — ${c.name}`,place:c.place||'',type:'',status:'À enquêter',goal:`Compléter ou documenter la recherche concernant ${c.name}${c.sosa!=null?` (Sosa ${c.sosa})`:''}.`,date:'',notes:'Dossier créé depuis le contexte généalogique partagé.',items:[],contextPersonId:c.personId||'',contextSosa:c.sosa??null,contextSource:c.source||'',createdAt:new Date().toISOString()};
  state.cases.push(dossier);state.activeId=id;save();render();LenaicBus.publish('ariane.case.created.from_context',{caseId:id,personId:c.personId,name:c.name,sosa:c.sosa},{source:'ariane',target:'genealogy',status:'done',notification:false});
 }catch(e){console.warn('Création Ariane depuis contexte',e)}
}

function augmentArboris(){
 if(APP!=='arboris')return;injectStyle();
 $$('[data-view-person]').forEach(btn=>{const id=btn.dataset.viewPerson,zone=btn.closest('.button-row');if(!id||!zone||zone.querySelector(`[data-eco-set-person="${CSS.escape(id)}"]`))return;const b=document.createElement('button');b.type='button';b.className='btn small eco-context-action';b.dataset.ecoSetPerson=id;b.textContent='◎ Contexte';zone.appendChild(b)});
}
function setArborisContext(id){const d=read('memoire-famille-data',{}),p=(d.people||[]).find(x=>String(x.id)===String(id));if(!p)return;LenaicContext.set({personId:p.id,name:personName(p),sosa:p.sosa??null,birth:dateText(p.birth),death:dateText(p.death),place:val(p,'birth.commune')||val(p,'birth.place')||'',meta:{branch:p.branch||''}},{source:'arboris'})}
function augmentPistoria(){
 if(APP!=='pistoria')return;injectStyle();$$('[data-open-investigation]').forEach(btn=>{const id=btn.dataset.openInvestigation,zone=btn.closest('.button-row');if(!id||!zone||zone.querySelector(`[data-eco-set-investigation="${CSS.escape(id)}"]`))return;const b=document.createElement('button');b.type='button';b.className='btn small eco-context-action';b.dataset.ecoSetInvestigation=id;b.textContent='◎ Contexte';zone.appendChild(b)});
}
function setPistoriaContext(id){const d=read('pistoria_private_v3',{}),inv=(d.investigations||[]).find(x=>String(x.id)===String(id));if(!inv)return;let personId=inv.personId||inv.arborisPersonId||'';if(!personId){const gp=(d.genealogy?.people||[]).find(p=>(inv.sosa!=null&&p.sosa!=null&&Number(p.sosa)===Number(inv.sosa))||((p.name||p.person)&&String(p.name||p.person).trim().toLowerCase()===String(inv.person||inv.title||'').trim().toLowerCase()));personId=gp?.arborisPersonId||gp?.personId||gp?.id||''}LenaicContext.set({personId:personId||`pistoria:${inv.id}`,name:inv.person||inv.title||'Ancêtre',sosa:inv.sosa??null,birth:inv.birthDate||'',death:inv.deathDate||'',place:inv.place||'',meta:{investigationId:inv.id}},{source:'pistoria'})}

document.addEventListener('click',e=>{const a=e.target.closest('[data-eco-set-person]');if(a){e.preventDefault();setArborisContext(a.dataset.ecoSetPerson);return}const p=e.target.closest('[data-eco-set-investigation]');if(p){e.preventDefault();setPistoriaContext(p.dataset.ecoSetInvestigation)}});

function pistoriaArianeInbox(){
 if(APP!=='pistoria'||!window.LenaicBus)return;injectStyle();const rows=LenaicBus.pending({type:'ariane.case.result',source:'ariane',target:'pistoria'});let box=$('#ecoArianeResults');
 if(!rows.length){box?.remove();return}
 if(!box){box=document.createElement('div');box.id='ecoArianeResults';box.className='eco-result-inbox';const anchor=$('#ecoContextBar')||$('header')||document.body.firstElementChild;anchor?.insertAdjacentElement('afterend',box)}
 const e=rows[0],p=e.payload||{};box.innerHTML=`<strong>ARIANE → PISTORIA · RÉSULTAT À CLASSER</strong><span>${esc(p.title||'Une enquête Ariane a été terminée.')}</span><div class="eco-result-actions"><button data-eco-ariane-status="found" data-event="${esc(e.id)}">ACTE TROUVÉ</button><button data-eco-ariane-status="negative" data-event="${esc(e.id)}">INFRUCTUEUSE</button><button data-eco-ariane-status="partial" data-event="${esc(e.id)}">RÉSULTAT PARTIEL</button><button data-eco-ariane-ignore data-event="${esc(e.id)}">IGNORER</button></div>${rows.length>1?`<small>+ ${rows.length-1} autre${rows.length>2?'s':''} résultat${rows.length>2?'s':''} en attente</small>`:''}`;
}
function applyArianeResult(eventId,status){
 const ev=LenaicBus.get(eventId);if(!ev)return;const p=ev.payload||{};let applied=false;
 try{
  if(typeof window.getInvestigation==='function'&&typeof window.saveData==='function'){
   const inv=window.getInvestigation(p.pistoriaInvestigationId),step=(inv?.steps||[]).find(x=>String(x.id)===String(p.pistoriaStepId));
   if(step){step.status=status;if(typeof window.unlockNext==='function')window.unlockNext(inv,step);window.saveData();applied=true;if(typeof window.openInvestigation==='function')window.openInvestigation(inv.id)}
  }
 }catch(_e){}
 if(!applied){
  const d=read('pistoria_private_v3',{}),inv=(d.investigations||[]).find(x=>String(x.id)===String(p.pistoriaInvestigationId)),step=(inv?.steps||[]).find(x=>String(x.id)===String(p.pistoriaStepId));
  if(step){step.status=status;const i=(inv.steps||[]).findIndex(x=>x.id===step.id),next=(inv.steps||[]).slice(i+1).find(x=>x.status==='locked');if(next)next.status='todo';if(!(inv.steps||[]).some(x=>['todo','locked'].includes(x.status))&&status==='found')inv.status='closed';localStorage.setItem('pistoria_private_v3',JSON.stringify(d));applied=true}
 }
 if(applied)LenaicBus.ack(eventId,{consumer:'pistoria',stepStatus:status,appliedAt:new Date().toISOString()});pistoriaArianeInbox();maybeIndex();
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-eco-ariane-status]');if(b){applyArianeResult(b.dataset.event,b.dataset.ecoArianeStatus);return}const i=e.target.closest('[data-eco-ariane-ignore]');if(i){LenaicBus.ignore(i.dataset.event,{consumer:'pistoria'});pistoriaArianeInbox()}});
if(APP==='pistoria'&&window.LenaicBus){pistoriaArianeInbox();LenaicBus.subscribe(()=>pistoriaArianeInbox())}

function deepLink(){const p=new URLSearchParams(location.search);try{
 if(APP==='arboris'&&p.get('person')){const id=p.get('person');setTimeout(()=>{try{if(typeof activeTab!=='undefined'){activeTab='people';if(typeof peopleView!=='undefined')peopleView='people';if(typeof render==='function')render()}setTimeout(()=>document.querySelector(`[data-view-person="${CSS.escape(id)}"]`)?.click(),120)}catch(_e){}},250)}
 if(APP==='scriptoria'&&p.get('search')){const q=p.get('search');setTimeout(()=>{try{if(typeof currentTab!=='undefined'){currentTab='people';if(typeof renderNav==='function')renderNav();if(typeof renderMain==='function')renderMain()}setTimeout(()=>{const i=document.querySelector('[name="peopleSearch"]');if(i){i.value=q;i.dispatchEvent(new Event('input',{bubbles:true}))}},120)}catch(_e){}},300)}
 if(APP==='pistoria'&&p.get('investigation')){const id=p.get('investigation');setTimeout(()=>document.querySelector(`[data-open-investigation="${CSS.escape(id)}"]`)?.click(),450)}
 if(APP==='ariane'&&p.get('case')){const id=p.get('case');setTimeout(()=>{try{if(typeof state!=='undefined'&&state.cases?.some(c=>String(c.id)===String(id))){state.activeId=id;save();render()}}catch(_e){}},250)}
 if(APP==='scribe'&&p.get('draft')){const id=p.get('draft');setTimeout(()=>{try{if(typeof openDraft==='function')openDraft(id)}catch(_e){}},350)}
 }catch(_e){}
}

if(CONTEXT_APPS.has(APP)){contextBar();LenaicContext.subscribe(()=>contextBar())}
const observer=new MutationObserver(()=>{augmentArboris();augmentPistoria()});observer.observe(document.documentElement,{subtree:true,childList:true});augmentArboris();augmentPistoria();deepLink();
})();
