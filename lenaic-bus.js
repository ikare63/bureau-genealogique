/* Lénaïc Ecosystem Core v2.0 — bus, notifications, contexte, recherche et modules. */
(function(global){
  'use strict';

  const BUS_V2='lenaic-bus-v2';
  const BUS_V1='lenaic-bus-v1';
  const NOTIF_KEY='lenaic-notifications-v1';
  const CONTEXT_KEY='lenaic-genealogy-context-v1';
  const SEARCH_KEY='lenaic-search-index-v1';
  const MODULE_STATE_KEY='lenaic-modules-v1';
  const CHANNEL='lenaic-ecosystem-v2';
  const MAX_EVENTS=300;
  const MAX_NOTIFICATIONS=240;
  let channel=null;
  try{ if('BroadcastChannel' in global) channel=new BroadcastChannel(CHANNEL); }catch(_e){}

  const now=()=>new Date().toISOString();
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const uid=(prefix='lx')=>`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const readJson=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key)||'null');return v??fallback}catch(_e){return fallback}};
  const writeJson=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true}catch(_e){return false}};
  const sourceFromPath=()=>{
    const p=location.pathname.split('/').filter(Boolean);
    const repo=p[0]||'web',file=(p[p.length-1]||'').toLowerCase();
    if(repo==='bureau-genealogique'){
      if(file==='index2.html')return'scriptoria';
      if(file==='index3.html')return'pistoria';
      return'arboris';
    }
    if(repo==='aide_archive')return file.includes('scribe')?'scribe':'ariane';
    if(repo==='lenaic-express')return'lenaic-express';
    if(repo==='3615lenaic')return file==='cms.html'?'nexus':'3615';
    return repo;
  };
  const emit=(kind,detail)=>{
    try{global.dispatchEvent(new CustomEvent('lenaicecosystemchange',{detail:{kind,detail}}))}catch(_e){}
    try{channel?.postMessage({kind,detail})}catch(_e){}
  };
  const dedupeById=items=>{
    const map=new Map();
    for(const item of items||[])if(item?.id)map.set(item.id,item);
    return [...map.values()];
  };

  /* ------------------------------ BUS V2 ------------------------------ */
  function readBusStore(key){const v=readJson(key,[]);return Array.isArray(v)?v:[]}
  function readBus(){
    const modern=readBusStore(BUS_V2),legacy=readBusStore(BUS_V1);
    return dedupeById([...legacy,...modern]).sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
  }
  function writeBus(events){
    const trimmed=(events||[]).slice(-MAX_EVENTS);
    writeJson(BUS_V2,trimmed);
    // Miroir v1 : permet aux anciennes versions d'apps/NEXUS de continuer à voir les événements.
    writeJson(BUS_V1,trimmed.map(e=>({...e,version:e.version||2})));
    return trimmed;
  }
  function defaultNotificationForEvent(event){
    if(event.type==='archive.response.received')return{
      source:event.source||'scribe',priority:'high',title:'Réponse d’archives reçue',
      message:event.payload?.title||event.payload?.contact||'Une réponse Scribe est à traiter.',
      action:{label:'OUVRIR SCRIBE',url:`/aide_archive/Scribe-v3.html${event.payload?.draftId?`?draft=${encodeURIComponent(event.payload.draftId)}`:''}`},
      dedupeKey:`scribe-response:${event.payload?.draftId||event.id}`
    };
    if(event.type==='ariane.case.result')return{
      source:'ariane',priority:'normal',title:'Résultat Ariane à classer',
      message:event.payload?.title||'Une enquête Ariane terminée doit être reportée dans Pistoria.',
      action:{label:'OUVRIR PISTORIA',url:'/bureau-genealogique/index3.html'},
      dedupeKey:`ariane-result:${event.payload?.caseId||event.id}`
    };
    if(event.type==='genealogy.context.changed')return null;
    return null;
  }
  function publish(type,payload={},options={}){
    const event={
      id:uid('lb'),version:2,type:String(type),source:options.source||sourceFromPath(),target:options.target||null,
      status:options.status||'pending',priority:options.priority||'normal',actionRequired:!!options.actionRequired,
      entity:options.entity||null,createdAt:now(),updatedAt:null,payload:payload||{}
    };
    const events=readBus();events.push(event);writeBus(events);emit('bus',event);
    const notif=options.notification===false?null:(options.notification||defaultNotificationForEvent(event));
    if(notif)Notifications.create({...notif,relatedEventId:event.id});
    return event;
  }
  function busGet(eventId){return readBus().find(e=>e.id===eventId)||null}
  function busList(filters={}){
    return readBus().filter(e=>{
      if(filters.status&&e.status!==filters.status)return false;
      if(filters.type&&e.type!==filters.type)return false;
      if(filters.source&&e.source!==filters.source)return false;
      if(filters.target&&e.target!==filters.target)return false;
      if(filters.actionRequired!==undefined&&!!e.actionRequired!==!!filters.actionRequired)return false;
      return true;
    });
  }
  function busPending(filters={}){return busList({...filters,status:'pending'})}
  function setBusStatus(eventId,status,meta={}){
    const events=readBus(),i=events.findIndex(e=>e.id===eventId);if(i<0)return null;
    events[i]={...events[i],status,updatedAt:now(),meta:{...(events[i].meta||{}),...meta}};
    writeBus(events);emit('bus',events[i]);return events[i];
  }
  function busAck(id,meta={}){return setBusStatus(id,'accepted',meta)}
  function busIgnore(id,meta={}){return setBusStatus(id,'ignored',meta)}
  function busDone(id,meta={}){return setBusStatus(id,'done',meta)}
  function busCleanup(days=45){
    const cutoff=Date.now()-Math.max(1,days)*86400000;
    const events=readBus().filter(e=>e.status==='pending'||new Date(e.updatedAt||e.createdAt||0).getTime()>=cutoff);
    writeBus(events);return events.length;
  }
  function subscribeBus(fn){
    if(typeof fn!=='function')return()=>{};
    const custom=e=>{if(e.detail?.kind==='bus')fn(e.detail.detail||null)};
    const storage=e=>{if(e.key===BUS_V2||e.key===BUS_V1)fn(null)};
    const bc=e=>{if(e.data?.kind==='bus')fn(e.data.detail||null)};
    global.addEventListener('lenaicecosystemchange',custom);global.addEventListener('storage',storage);
    try{channel?.addEventListener('message',bc)}catch(_e){}
    return()=>{global.removeEventListener('lenaicecosystemchange',custom);global.removeEventListener('storage',storage);try{channel?.removeEventListener('message',bc)}catch(_e){}};
  }

  /* --------------------------- NOTIFICATIONS -------------------------- */
  const Notifications={
    storageKey:NOTIF_KEY,
    read(){const v=readJson(NOTIF_KEY,[]);return Array.isArray(v)?v:[]},
    write(items){const trimmed=(items||[]).slice(-MAX_NOTIFICATIONS);writeJson(NOTIF_KEY,trimmed);emit('notifications',null);return trimmed},
    create(input={}){
      const items=this.read(),key=input.dedupeKey||null;
      let n=key?items.find(x=>x.dedupeKey===key&&x.status!=='done'):null;
      const patch={source:input.source||sourceFromPath(),title:String(input.title||'Notification'),message:String(input.message||''),priority:input.priority||'normal',action:input.action||null,dedupeKey:key,relatedEventId:input.relatedEventId||null,meta:input.meta||{},dueAt:input.dueAt||null,expiresAt:input.expiresAt||null};
      if(n){Object.assign(n,patch,{updatedAt:now()});if(input.reopen)n.status='new'}
      else{n={id:uid('nt'),version:1,status:'new',createdAt:now(),updatedAt:null,snoozeUntil:null,...patch};items.push(n)}
      this.write(items);return clone(n);
    },
    list(filters={}){
      const t=Date.now();return this.read().filter(n=>{
        if(filters.status&&n.status!==filters.status)return false;
        if(filters.source&&n.source!==filters.source)return false;
        if(filters.active){if(n.status==='done')return false;if(n.expiresAt&&Date.parse(n.expiresAt)<t)return false;if(n.status==='snoozed'&&Date.parse(n.snoozeUntil||0)>t)return false}
        return true;
      }).sort((a,b)=>{
        const rank={urgent:4,high:3,normal:2,low:1};return (rank[b.priority]||2)-(rank[a.priority]||2)||Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0);
      });
    },
    setStatus(id,status,extra={}){const items=this.read(),i=items.findIndex(n=>n.id===id);if(i<0)return null;items[i]={...items[i],status,updatedAt:now(),...extra};this.write(items);return clone(items[i])},
    markRead(id){return this.setStatus(id,'read')},
    done(id){return this.setStatus(id,'done',{doneAt:now()})},
    snooze(id,hours=24){return this.setStatus(id,'snoozed',{snoozeUntil:new Date(Date.now()+Math.max(1,hours)*3600000).toISOString()})},
    remove(id){const before=this.read(),after=before.filter(n=>n.id!==id);this.write(after);return before.length-after.length},
    cleanup(days=60){const cutoff=Date.now()-Math.max(1,days)*86400000;return this.write(this.read().filter(n=>n.status!=='done'||Date.parse(n.doneAt||n.updatedAt||n.createdAt||0)>=cutoff)).length},
    subscribe(fn){if(typeof fn!=='function')return()=>{};const custom=e=>{if(e.detail?.kind==='notifications')fn()};const storage=e=>{if(e.key===NOTIF_KEY)fn()};const bc=e=>{if(e.data?.kind==='notifications')fn()};global.addEventListener('lenaicecosystemchange',custom);global.addEventListener('storage',storage);try{channel?.addEventListener('message',bc)}catch(_e){}return()=>{global.removeEventListener('lenaicecosystemchange',custom);global.removeEventListener('storage',storage);try{channel?.removeEventListener('message',bc)}catch(_e){}}}
  };

  /* ----------------------- CONTEXTE GÉNÉALOGIQUE ---------------------- */
  const GenealogyContext={
    storageKey:CONTEXT_KEY,
    get(){return readJson(CONTEXT_KEY,null)},
    set(person={},options={}){
      const value={version:1,personId:String(person.personId||person.id||''),name:String(person.name||person.label||'').trim(),sosa:person.sosa??null,birth:person.birth||'',death:person.death||'',place:person.place||'',source:options.source||person.source||sourceFromPath(),updatedAt:now(),meta:person.meta||{}};
      if(!value.personId&&!value.name)return null;writeJson(CONTEXT_KEY,value);emit('context',value);publish('genealogy.context.changed',value,{source:value.source,target:'genealogy',status:'done',notification:false});return clone(value);
    },
    clear(){localStorage.removeItem(CONTEXT_KEY);emit('context',null)},
    subscribe(fn){if(typeof fn!=='function')return()=>{};const custom=e=>{if(e.detail?.kind==='context')fn(e.detail.detail||null)};const storage=e=>{if(e.key===CONTEXT_KEY)fn(this.get())};const bc=e=>{if(e.data?.kind==='context')fn(e.data.detail||null)};global.addEventListener('lenaicecosystemchange',custom);global.addEventListener('storage',storage);try{channel?.addEventListener('message',bc)}catch(_e){}return()=>{global.removeEventListener('lenaicecosystemchange',custom);global.removeEventListener('storage',storage);try{channel?.removeEventListener('message',bc)}catch(_e){}}}
  };

  /* ---------------------------- RECHERCHE ----------------------------- */
  const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const Search={
    storageKey:SEARCH_KEY,
    read(){const v=readJson(SEARCH_KEY,{version:1,apps:{}});return v&&typeof v==='object'?{version:1,apps:v.apps&&typeof v.apps==='object'?v.apps:{}}:{version:1,apps:{}}},
    publish(appId,items=[]){const data=this.read();data.apps[String(appId)]={updatedAt:now(),items:(Array.isArray(items)?items:[]).slice(0,3000).map(x=>({id:String(x.id||uid('sr')),type:x.type||'item',label:String(x.label||''),subtitle:String(x.subtitle||''),url:String(x.url||''),keywords:Array.isArray(x.keywords)?x.keywords.map(String):[],meta:x.meta||{}}))};writeJson(SEARCH_KEY,data);emit('search',{appId});return data.apps[String(appId)].items.length},
    remove(appId){const data=this.read();delete data.apps[String(appId)];writeJson(SEARCH_KEY,data);emit('search',{appId});},
    query(query,options={}){const q=norm(query);if(q.length<2)return[];const tokens=q.split(/\s+/).filter(Boolean),apps=options.apps?new Set(options.apps):null,out=[];for(const [appId,pack] of Object.entries(this.read().apps)){if(apps&&!apps.has(appId))continue;for(const item of pack.items||[]){const hay=norm([item.label,item.subtitle,...(item.keywords||[])].join(' '));if(!tokens.every(t=>hay.includes(t)))continue;let score=0;if(norm(item.label).startsWith(q))score+=20;if(norm(item.label).includes(q))score+=12;if(hay.includes(q))score+=8;score+=tokens.reduce((s,t)=>s+(norm(item.label).includes(t)?4:1),0);out.push({...clone(item),appId,score})}}return out.sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label,'fr')).slice(0,options.limit||60)},
    subscribe(fn){if(typeof fn!=='function')return()=>{};const custom=e=>{if(e.detail?.kind==='search')fn(e.detail.detail)};const storage=e=>{if(e.key===SEARCH_KEY)fn(null)};global.addEventListener('lenaicecosystemchange',custom);global.addEventListener('storage',storage);return()=>{global.removeEventListener('lenaicecosystemchange',custom);global.removeEventListener('storage',storage)}}
  };

  /* ----------------------- MODULES / RAPPELS -------------------------- */
  function moduleState(){const v=readJson(MODULE_STATE_KEY,{version:1,states:{}});return v&&typeof v==='object'?{version:1,states:v.states&&typeof v.states==='object'?v.states:{}}:{version:1,states:{}}}
  function saveModuleState(v){writeJson(MODULE_STATE_KEY,v);emit('modules',null)}
  function parseDateLocal(s){if(!s)return null;const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),12):new Date(s)}
  function dayStart(d=new Date()){return new Date(d.getFullYear(),d.getMonth(),d.getDate(),12)}
  function moduleOccurrence(def,date=new Date()){
    const start=parseDateLocal(def.startDate)||dayStart(date),today=dayStart(date);if(today<dayStart(start))return{active:false,index:-1,periodKey:null};
    const rec=def.recurrence||'once';let index=0,periodKey='once';
    if(rec==='daily'){index=Math.floor((today-dayStart(start))/86400000);periodKey=`d:${today.toISOString().slice(0,10)}`}
    else if(rec==='weekly'){index=Math.floor((today-dayStart(start))/(7*86400000));const s=new Date(dayStart(start));s.setDate(s.getDate()+index*7);periodKey=`w:${s.toISOString().slice(0,10)}`}
    else if(rec==='monthly'){index=(today.getFullYear()-start.getFullYear())*12+(today.getMonth()-start.getMonth());periodKey=`m:${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`}
    else{periodKey='once';index=0}
    const occurrences=Number(def.occurrences)||0;if(occurrences>0&&index>=occurrences)return{active:false,index,periodKey};
    return{active:true,index,periodKey};
  }
  const Modules={
    storageKey:MODULE_STATE_KEY,
    state:moduleState,
    occurrence:moduleOccurrence,
    resolve(def,date=new Date()){
      const occ=moduleOccurrence(def,date),store=moduleState(),st=store.states?.[def.id]||{},period=occ.periodKey?st.periods?.[occ.periodKey]:null;
      const startValue=Number(def.startValue)||0,step=Number(def.stepValue)||0,currentValue=startValue+Math.max(0,occ.index)*step;
      const cumulativePlanned=occ.index>=0?(occ.index+1)*(2*startValue+occ.index*step)/2:0;
      const completedValues=Object.values(st.periods||{}).filter(x=>x?.doneAt).reduce((sum,x)=>sum+(Number(x.value)||0),0);
      const target=Number(def.target)||0;
      return{...occ,done:!!period?.doneAt,doneAt:period?.doneAt||null,currentValue,cumulativePlanned,completedValue:completedValues,target,progress:target?Math.min(100,completedValues/target*100):0,state:clone(st)};
    },
    complete(def,value=null,date=new Date()){
      const occ=moduleOccurrence(def,date);if(!occ.active||!occ.periodKey)return null;const store=moduleState();store.states[def.id]=store.states[def.id]||{periods:{}};store.states[def.id].periods=store.states[def.id].periods||{};const v=value==null?(def.kind==='progressive'?(Number(def.startValue)||0)+Math.max(0,occ.index)*(Number(def.stepValue)||0):1):Number(value);store.states[def.id].periods[occ.periodKey]={doneAt:now(),value:v};saveModuleState(store);return this.resolve(def,date)},
    undo(def,date=new Date()){const occ=moduleOccurrence(def,date),store=moduleState();if(store.states?.[def.id]?.periods&&occ.periodKey)delete store.states[def.id].periods[occ.periodKey];saveModuleState(store);return this.resolve(def,date)},
    setValue(def,value,date=new Date()){const occ=moduleOccurrence(def,date);if(!occ.active||!occ.periodKey)return null;const store=moduleState();store.states[def.id]=store.states[def.id]||{periods:{},values:{}};store.states[def.id].values=store.states[def.id].values||{};store.states[def.id].values[occ.periodKey]={value:Number(value)||0,updatedAt:now()};saveModuleState(store);return this.resolve(def,date)},
    subscribe(fn){if(typeof fn!=='function')return()=>{};const custom=e=>{if(e.detail?.kind==='modules')fn()};const storage=e=>{if(e.key===MODULE_STATE_KEY)fn()};global.addEventListener('lenaicecosystemchange',custom);global.addEventListener('storage',storage);return()=>{global.removeEventListener('lenaicecosystemchange',custom);global.removeEventListener('storage',storage)}}
  };

  global.LenaicBus={version:2,storageKey:BUS_V2,legacyStorageKey:BUS_V1,publish,get:busGet,list:busList,pending:busPending,ack:busAck,ignore:busIgnore,done:busDone,setStatus:setBusStatus,cleanup:busCleanup,subscribe:subscribeBus};
  global.LenaicNotifications=Notifications;global.LenaicNotify=Notifications;
  global.LenaicGenealogyContext=GenealogyContext;global.LenaicContext=GenealogyContext;
  global.LenaicSearch=Search;global.LenaicModules=Modules;
  global.LenaicEcosystem={version:'2.0',keys:{bus:BUS_V2,notifications:NOTIF_KEY,context:CONTEXT_KEY,search:SEARCH_KEY,modules:MODULE_STATE_KEY},source:sourceFromPath};

  busCleanup();Notifications.cleanup();
})(window);
