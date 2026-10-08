import {Plan, under} from './core';
import {Transaction} from './transaction';
export interface Outcome { plan?:Plan; hash:string; state:'review'|'error'|'undone'; message:string; time:string }
export type HistoryStatus='done'|'pending'|'review'|'error';
export interface HistoryRow {
 id:string; status:HistoryStatus; title:string; original:string; current:string;
 destination?:string; time:string; reason:string; summary?:string;
 outcome?:Outcome; transaction?:Transaction; restored?:boolean; missing?:boolean;
}
export const folderOf=(path:string)=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
export const titleOf=(path:string)=>(path.split('/').pop()??path).replace(/\.md$/i,'').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'');
export function historyRows(paths:string[],inbox:string,outcomes:Record<string,Outcome>,history:Transaction[]):HistoryRow[]{
 const exists=new Set(paths);const blocked=new Set<string>();const result:HistoryRow[]=[];
 for(const t of history){
  if(t.status==='undone')continue;
  const done=t.status==='done';
  if(!done){blocked.add(t.original);blocked.add(t.target);}
  const current=exists.has(t.target)?t.target:!done && exists.has(t.original)?t.original:t.target;
  result.push({id:t.id,status:done?'done':'review',title:titleOf(t.target),original:t.original,current,destination:folderOf(t.target),time:t.time,reason:t.reason,transaction:t,missing:!exists.has(current)});
 }
 for(const path of paths){
  if(!under(path,inbox.replace(/\/$/,'')) || blocked.has(path))continue;
  const o=outcomes[path];
  result.push({id:'file:'+path,status:o?.state==='review'?'review':o?.state==='error'?'error':'pending',title:titleOf(path),original:path,current:path,destination:o?.plan?.folder,time:o?.time??'',reason:o?.message??'',summary:o?.plan?.summary,outcome:o,restored:o?.state==='undone'});
 }
 return result.sort((a,b)=>b.time.localeCompare(a.time)||a.title.localeCompare(b.title,'zh-CN'));
}
