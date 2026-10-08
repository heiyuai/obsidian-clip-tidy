export interface Transaction {
  id: string; original: string; target: string; before: string; after: string;
  status: 'applying' | 'done' | 'review' | 'undoing' | 'undone'; time: string; reason: string;
}
export interface Store {
  read(path:string):Promise<string | null>;
  replace(path:string, expected:string, next:string):Promise<void>;
  move(from:string,to:string):Promise<void>;
  persist():Promise<void>;
}
export async function applyTransaction(store: Store, t: Transaction): Promise<void> {
  // Persist the original before the first write. Never overwrite a collision or concurrent edit.
  await store.persist();
  if (await store.read(t.target) !== null) throw new Error('目标文件已存在。');
  await store.replace(t.original,t.before,t.after);
  await store.move(t.original,t.target);
  const actual=await store.read(t.target);
  if(actual===null) throw new Error('移动后无法读取文件。');
  if(actual!==t.after){t.status='review';await store.persist();throw new Error('移动时内容或链接发生变化，备份已保留，请检查后手动恢复。');}
  t.status='done';
  await store.persist();
}
export async function undoTransaction(store: Store,t:Transaction):Promise<void> {
  if(t.status!=='done' && t.status!=='review' && t.status!=='applying') throw new Error('此记录不能撤销。');
  const source=await store.read(t.original), target=await store.read(t.target);
  const atTarget=target!==null && source===null;
  const current=atTarget?target:source;
  if((source!==null && target!==null) || current!==t.after) throw new Error('笔记已被修改、移动或原路径被占用；请从记录复制原文，避免覆盖你的编辑。');
  t.status='undoing'; await store.persist();
  if(atTarget) await store.move(t.target,t.original);
  // Moving through Obsidian can update relative links; read the new version before restoring.
  const moved=await store.read(t.original);
  if(moved!==t.after){t.status='review';await store.persist();throw new Error('移动时内容或链接发生变化，已停止恢复；请从原文备份恢复。');}
  await store.replace(t.original,moved,t.before);
  t.status='undone'; await store.persist();
}
export async function recoverTransaction(store:Store,t:Transaction):Promise<void> {
  if(t.status!=='applying' && t.status!=='undoing') return;
  const a=await store.read(t.original), b=await store.read(t.target);
  if(t.status==='undoing') {
    if(a===t.before && b===null) t.status='undone'; else t.status='review';
  } else if(a===null && b===t.after) t.status='done';
  else if(a===t.before && b===null) t.status='undone';
  else t.status='review';
  await store.persist();
}
