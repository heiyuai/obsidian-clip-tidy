import {describe,it,expect,vi,beforeEach} from 'vitest';
const {request,notices}=vi.hoisted(()=>({request:vi.fn(),notices:[] as string[]}));
vi.mock('obsidian',()=>({
 Plugin:class {app:any;manifest={id:'clip-tidy'};saveData=vi.fn(async()=>{});},
 TFile:class {extension='md';stat={ctime:0};constructor(public path:string){}get name(){return this.path.split('/').pop()!;}get basename(){return this.name.slice(0,-3);}},
 TFolder:class {constructor(public path:string){}},
 Modal:class{},PluginSettingTab:class{},Setting:class{},Notice:class{constructor(s:string){notices.push(s);}},requestUrl:request,
}));
import ClipTidy from '../src/main';
import {TFile,TFolder} from 'obsidian';
import {defaults} from '../src/core';
function setup(){
 const p=new ClipTidy({} as any,{} as any);const files=new Map<string,{f:TFile;text:string}>();
 function add(path:string,text:string){const f=Object.assign(new TFile(),{path,extension:'md',stat:{ctime:files.size}});files.set(path,{f,text});return f;}
 add('待整理/收藏.md','# Agent 长期记忆\n正文');add('资料/AI/参考.md','已有参考');
 p.data={settings:{...defaults,model:'test',enabled:true,destinations:'资料/AI'},outcomes:{},history:[]};
 const folders=new Set(['待整理','资料/AI']);
 (p as any).app={
  vault:{getAllLoadedFiles:()=>[...folders].map(path=>Object.assign(new TFolder(),{path})),getMarkdownFiles:()=>[...files.values()].map(x=>x.f),getAbstractFileByPath:(path:string)=>files.get(path)?.f??(folders.has(path)?Object.assign(new TFolder(),{path}):null),read:async(f:TFile)=>files.get(f.path)!.text,cachedRead:async(f:TFile)=>files.get(f.path)!.text,process:async(f:TFile,fn:(t:string)=>string)=>{const entry=files.get(f.path)!;entry.text=fn(entry.text);}},
  metadataCache:{getFileCache:()=>({})},
  fileManager:{renameFile:async(f:TFile,to:string)=>{const entry=files.get(f.path)!;if(files.has(to))throw Error('exists');files.delete(f.path);f.path=to;files.set(to,entry);}},
 };
 return {p,files,add};
}
const plan={folder:'资料/AI',title:'测试摘要',summary:'Agent 记忆方案。',tags:['Agent'],related:[],confidence:.95,reason:'技术资料'};
beforeEach(()=>{request.mockReset();notices.length=0;vi.stubGlobal('window',globalThis);request.mockResolvedValue({status:200,json:{choices:[{message:{content:JSON.stringify(plan)}}]}});});
describe('plugin integration with simulated Obsidian and model',()=>{
 it('archives, preserves source, avoids duplicate requests and undoes',async()=>{
  const {p,files}=setup();const before=files.get('待整理/收藏.md')!.text;
  await p.run(true);expect(files.has('资料/AI/收藏.md')).toBe(true);expect(files.get('资料/AI/收藏.md')!.text.startsWith(before)).toBe(true);
  await p.run(true);expect(request).toHaveBeenCalledTimes(1);
  await p.undo(p.data.history[0]);expect(files.get('待整理/收藏.md')!.text).toBe(before);
  await p.run(true);expect(request).toHaveBeenCalledTimes(1);
 });
 it('organizes only the selected note when retrying',async()=>{
  const {p,files,add}=setup();add('待整理/其他.md','other');await p.run(true,'待整理/其他.md');
  expect(request).toHaveBeenCalledTimes(1);expect(files.has('待整理/收藏.md')).toBe(true);expect(files.has('资料/AI/其他.md')).toBe(true);
 });
 it('discovers existing folders when no list is configured',async()=>{
  const {p,files}=setup();p.config.destinations='';await p.run(true);
  expect(files.has('资料/AI/收藏.md')).toBe(true);
  const body=JSON.parse(request.mock.calls[0][0].body);
  expect(JSON.parse(body.messages[1].content).allowedFolders).toEqual(['资料/AI']);
 });
 it('holds uncertain notes, then archives only after explicit approval',async()=>{
  const {p,files}=setup();request.mockResolvedValue({status:200,json:{choices:[{message:{content:JSON.stringify({...plan,confidence:.3})}}]}});
  await p.run(true);expect(files.has('待整理/收藏.md')).toBe(true);const o=p.data.outcomes['待整理/收藏.md'];expect(o.plan?.confidence).toBe(.3);
  await p.approve('待整理/收藏.md',o);expect(files.has('资料/AI/收藏.md')).toBe(true);expect(request).toHaveBeenCalledTimes(1);
 });
 it('refuses stale approval after the source is edited',async()=>{
  const {p,files}=setup();request.mockResolvedValue({status:200,json:{choices:[{message:{content:JSON.stringify({...plan,confidence:.3})}}]}});
  await p.run(true);files.get('待整理/收藏.md')!.text='new user content';await p.approve('待整理/收藏.md',p.data.outcomes['待整理/收藏.md']);expect(files.get('待整理/收藏.md')!.text).toBe('new user content');expect(p.data.history).toHaveLength(0);
 });
 it('retains source on quota error and does not repeatedly retry it',async()=>{
  const {p,files}=setup();request.mockResolvedValue({status:429});await p.run(true);await p.run(true);expect(files.has('待整理/收藏.md')).toBe(true);expect(request).toHaveBeenCalledTimes(1);expect(p.data.outcomes['待整理/收藏.md'].state).toBe('error');
 });
 it('does not commit a response that arrives after stop',async()=>{
  const {p,files}=setup();request.mockImplementation(async()=>{p.stop();return {status:200,json:{choices:[{message:{content:JSON.stringify(plan)}}]}};});await p.run(true);expect(files.has('待整理/收藏.md')).toBe(true);expect(p.data.history).toHaveLength(0);
 });
 it('honors batch limit and protects same-name notes',async()=>{
  const {p,files,add}=setup();p.config.batchSize=1;add('待整理/另一个.md','another');add('资料/AI/收藏.md','keep me');await p.run(true);expect(request).toHaveBeenCalledTimes(1);expect(files.get('资料/AI/收藏.md')!.text).toBe('keep me');expect(files.has('资料/AI/收藏 (2).md')).toBe(true);expect(files.has('待整理/另一个.md')).toBe(true);
 });
});
