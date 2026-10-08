import {describe,it,expect} from 'vitest';
import {historyRows,folderOf,Outcome} from '../src/history';
import {Transaction} from '../src/transaction';
const tx:Transaction={id:'1',original:'Inbox/a.md',target:'AI/a.md',before:'a',after:'b',status:'done',time:'2026-10-08',reason:'相关'};
const outcome=(state:Outcome['state']):Outcome=>({state,hash:'h',message:'原因',time:'2026-10-08'});
describe('history status view',()=>{
 it('separates archived, untouched, review and failed notes',()=>{
  const rows=historyRows(['AI/a.md','Inbox/b.md','Inbox/c.md','Inbox/d.md'],'Inbox',{'Inbox/c.md':outcome('review'),'Inbox/d.md':outcome('error')},[tx]);
  expect(Object.fromEntries(rows.map(r=>[r.title,r.status]))).toEqual({a:'done',b:'pending',c:'review',d:'error'});
 });
 it('shows undone source as pending and excludes undone archive',()=>{
  const rows=historyRows(['Inbox/a.md'],'Inbox',{'Inbox/a.md':outcome('undone')},[{...tx,status:'undone'}]);
  expect(rows).toHaveLength(1);expect(rows[0].status).toBe('pending');expect(rows[0].restored).toBe(true);
 });
 it('shows interrupted writes once under review',()=>{
  const rows=historyRows(['Inbox/a.md'],'Inbox',{'Inbox/a.md':outcome('error')},[{...tx,status:'review'}]);
  expect(rows).toHaveLength(1);expect(rows[0].status).toBe('review');expect(rows[0].current).toBe('Inbox/a.md');
 });
 it('ignores obsolete outcomes but keeps missing archived backups',()=>{
  const rows=historyRows([],'Inbox',{'Inbox/removed.md':outcome('review')},[tx]);
  expect(rows).toHaveLength(1);expect(rows[0].missing).toBe(true);
 });
 it('handles root and nested directories',()=>{expect(folderOf('a.md')).toBe('');expect(folderOf('AI/models/a.md')).toBe('AI/models');});
});
