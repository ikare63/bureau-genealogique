/* Lénaïc Bus v1 — petit bus local commun aux micro-sites du même domaine. */
(function(global){
  'use strict';
  const STORAGE_KEY='lenaic-bus-v1';
  const CHANNEL_NAME='lenaic-bus-v1';
  const MAX_EVENTS=120;
  let channel=null;
  try{ if('BroadcastChannel' in global) channel=new BroadcastChannel(CHANNEL_NAME); }catch(e){}

  function read(){
    try{
      const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');
      return Array.isArray(value)?value:[];
    }catch(e){ return []; }
  }
  function write(events){
    const trimmed=events.slice(-MAX_EVENTS);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(trimmed));
    return trimmed;
  }
  function id(){
    return 'lb-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  }
  function sourceFromPath(){
    const part=location.pathname.split('/').filter(Boolean)[0];
    return part||'web';
  }
  function emit(detail){
    try{ global.dispatchEvent(new CustomEvent('lenaicbuschange',{detail})); }catch(e){}
    try{ channel?.postMessage({kind:'changed',detail}); }catch(e){}
  }
  function publish(type,payload={},options={}){
    const event={
      id:id(),
      version:1,
      type:String(type),
      source:options.source||sourceFromPath(),
      target:options.target||null,
      status:'pending',
      createdAt:new Date().toISOString(),
      updatedAt:null,
      payload
    };
    const events=read();events.push(event);write(events);emit(event);return event;
  }
  function get(eventId){ return read().find(e=>e.id===eventId)||null; }
  function list(filters={}){
    return read().filter(e=>{
      if(filters.status && e.status!==filters.status)return false;
      if(filters.type && e.type!==filters.type)return false;
      if(filters.source && e.source!==filters.source)return false;
      if(filters.target && e.target!==filters.target)return false;
      return true;
    });
  }
  function pending(filters={}){ return list({...filters,status:'pending'}); }
  function setStatus(eventId,status,meta={}){
    const events=read();const i=events.findIndex(e=>e.id===eventId);if(i<0)return null;
    events[i]={...events[i],status,updatedAt:new Date().toISOString(),meta:{...(events[i].meta||{}),...meta}};
    write(events);emit(events[i]);return events[i];
  }
  function ack(eventId,meta={}){ return setStatus(eventId,'accepted',meta); }
  function ignore(eventId,meta={}){ return setStatus(eventId,'ignored',meta); }
  function cleanup(days=30){
    const cutoff=Date.now()-days*86400000;
    const events=read().filter(e=>e.status==='pending'||new Date(e.updatedAt||e.createdAt).getTime()>=cutoff);
    write(events);return events.length;
  }
  function subscribe(fn){
    if(typeof fn!=='function')return()=>{};
    const custom=e=>fn(e.detail||null);
    const storage=e=>{if(e.key===STORAGE_KEY)fn(null)};
    const bc=e=>{if(e.data?.kind==='changed')fn(e.data.detail||null)};
    global.addEventListener('lenaicbuschange',custom);
    global.addEventListener('storage',storage);
    try{channel?.addEventListener('message',bc)}catch(e){}
    return()=>{
      global.removeEventListener('lenaicbuschange',custom);
      global.removeEventListener('storage',storage);
      try{channel?.removeEventListener('message',bc)}catch(e){}
    };
  }

  global.LenaicBus={version:1,storageKey:STORAGE_KEY,publish,get,list,pending,ack,ignore,cleanup,subscribe};
  cleanup();
})(window);
