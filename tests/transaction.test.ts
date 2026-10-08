import {describe,it,expect} from 'vitest';
import {Transaction,Store,applyTransaction,undoTransaction,recoverTransaction} from '../src/transaction';
function setup(){
 const files=new Map<string,string>([['待整理/a.md','original']]);let journal:Transaction|undefined;const operations:string[]=[];
 const t:Transaction={id:'test',original:'待整理/a.md',target:'资料/a.md',before:'original',after:'original\nsummary',status:'applying',time:'now',reason:'AI'};
 const store:Store={
  read:async p=>files.get(p)??null,
  replace:async(p,expected,next)=>{operations.push('write');if(files.get(p)!==expected)throw Error('concurrent edit');files.set(p,next);},
  move:async(from,to)=>{operations.push('move');if(files.has(to)||!files.has(from))throw Error('collision');files.set(to,files.get(from)!);files.delete(from);},
  persist:async()=>{operations.push('save');journal=structuredClone(t);},
 };
 return {files,t,store,operations,journal:()=>journal};
}
describe('transactional archive and undo',()=>{
 it('backs up before writing, moves once, and restores exact original',async()=>{
  const x=setup();await applyTransaction(x.store,x.t);
  expect(x.operations[0]).toBe('save');expect(x.files.get(x.t.target)).toBe('original\nsummary');expect(x.journal()?.before).toBe('original');
  await undoTransaction(x.store,x.t);expect(x.files.get(x.t.original)).toBe('original');expect(x.files.has(x.t.target)).toBe(false);expect(x.t.status).toBe('undone');
 });
 it('never overwrites a same-name destination',async()=>{
  const x=setup();x.files.set(x.t.target,'other');await expect(applyTransaction(x.store,x.t)).rejects.toThrow();expect(x.files.get(x.t.original)).toBe('original');expect(x.files.get(x.t.target)).toBe('other');
 });
 it('refuses edits made while AI was running',async()=>{
  const x=setup();x.files.set(x.t.original,'user edit');await expect(applyTransaction(x.store,x.t)).rejects.toThrow();expect(x.files.get(x.t.original)).toBe('user edit');
 });
 it('will not undo over a later user edit',async()=>{
  const x=setup();await applyTransaction(x.store,x.t);x.files.set(x.t.target,'later edit');await expect(undoTransaction(x.store,x.t)).rejects.toThrow();expect(x.files.get(x.t.target)).toBe('later edit');
 });
 it('will not undo into an occupied original path',async()=>{
  const x=setup();await applyTransaction(x.store,x.t);x.files.set(x.t.original,'new clip');await expect(undoTransaction(x.store,x.t)).rejects.toThrow();expect(x.files.get(x.t.original)).toBe('new clip');
 });
 it('recovers a crash after moving but before completion is saved',async()=>{
  const x=setup();x.files.delete(x.t.original);x.files.set(x.t.target,x.t.after);await recoverTransaction(x.store,x.t);expect(x.t.status).toBe('done');
 });
 it('preserves a crash after appending for explicit recovery',async()=>{
  const x=setup();x.files.set(x.t.original,x.t.after);await recoverTransaction(x.store,x.t);expect(x.t.status).toBe('review');await undoTransaction(x.store,x.t);expect(x.files.get(x.t.original)).toBe('original');
 });
 it('detects a completed undo following a crash',async()=>{
  const x=setup();x.t.status='undoing';await recoverTransaction(x.store,x.t);expect(x.t.status).toBe('undone');
 });
 it('does not write when backup persistence fails',async()=>{
  const x=setup();x.store.persist=async()=>{throw Error('disk full');};await expect(applyTransaction(x.store,x.t)).rejects.toThrow();expect(x.operations).toEqual([]);expect(x.files.get(x.t.original)).toBe('original');
 });
 it('does not absorb concurrent edits during move into the undo snapshot',async()=>{
  const x=setup();const move=x.store.move;x.store.move=async(a,b)=>{await move(a,b);x.files.set(b,'user changed during move');};await expect(applyTransaction(x.store,x.t)).rejects.toThrow();expect(x.t.status).toBe('review');await expect(undoTransaction(x.store,x.t)).rejects.toThrow();expect(x.files.get(x.t.target)).toBe('user changed during move');
 });
});
