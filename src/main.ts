import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, EventRef, requestUrl } from 'obsidian';
import { defaults, Settings, Candidate, Plan, resolveFolders, validateSettings, safePath, under, rankCandidates, parsePlan, buildMessages, appendix, marker } from './core';
import { Store, Transaction, applyTransaction, undoTransaction, recoverTransaction } from './transaction';

import { Outcome, HistoryRow, HistoryStatus, historyRows, folderOf, titleOf } from './history';
interface Data { settings:Settings; outcomes:Record<string,Outcome>; history:Transaction[] }
const errorText=(e:unknown)=>e instanceof Error?e.message:'发生未知错误。';
async function hash(text:string):Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}

export default class ClipTidy extends Plugin {
  data:Data={settings:{...defaults},outcomes:{},history:[]};
  activePath:string|undefined; busy=false; stopped=false; generation=0; timer:number|undefined; pending=false;
  historyListeners=new Set<()=>void>();
  notifyHistory(){for(const cb of this.historyListeners){try{cb();}catch{/* A view must never interrupt persistence. */}}}
  status!:HTMLElement; saveChain:Promise<void>=Promise.resolve();
  get config(){return this.data.settings;}
  async onload() {
    const saved=await this.loadData();
    this.data={settings:{...defaults,...saved?.settings},outcomes:saved?.outcomes??{},history:saved?.history??[]};
    this.status=this.addStatusBarItem(); this.updateStatus();
    this.addRibbonIcon('archive','Clip Tidy：整理记录',()=>new HistoryModal(this.app,this).open());
    this.addCommand({id:'organize',name:'整理待整理目录',callback:()=>void this.run(true)});
    this.addCommand({id:'history',name:'查看整理记录 / 撤销',callback:()=>new HistoryModal(this.app,this).open()});
    this.addCommand({id:'stop',name:'停止当前整理',callback:()=>this.stop()});
    this.addSettingTab(new TidySettings(this.app,this));
    this.app.workspace.onLayoutReady(()=>{
      if(this.stopped) return;
      this.registerEvent(this.app.vault.on('create',f=>{if(f instanceof TFile)this.schedule(f);}));
      this.registerEvent(this.app.vault.on('modify',f=>{if(f instanceof TFile)this.schedule(f);}));
      void this.startup();
    });
  }
  async startup(){
    try {
      for(const t of this.data.history) await recoverTransaction(this.store(),t);
      if(this.config.enabled && this.config.onStartup) this.schedule();
    } catch {new Notice('Clip Tidy：恢复整理记录失败，请先查看记录。');}
  }
  onunload(){this.stopped=true;this.generation++;window.clearTimeout(this.timer);}
  updateStatus(text?:string){this.status?.setText('Clip Tidy · '+(text??(this.config.enabled?'就绪':'未启用')));this.notifyHistory();}
  stop(){this.generation++;window.clearTimeout(this.timer);this.pending=false;this.updateStatus('已停止');new Notice('已停止排队；已经开始的文件写入会安全完成。');}
  save(){
    // Serialize settings and journal writes, so backups cannot be lost to a settings update.
    this.saveChain=this.saveChain.catch(()=>{}).then(()=>this.saveData(JSON.parse(JSON.stringify(this.data))));
    return this.saveChain.then(()=>this.notifyHistory());
  }
  schedule(file?:TFile){
    if(!this.config.enabled || this.stopped || (file && !this.config.watch)) return;
    if(file && (file.extension!=='md' || !under(file.path,this.config.inbox.replace(/\/$/,'')))) return;
    if(file && file.path===this.activePath) return;
    if(this.busy){this.pending=true;return;}
    window.clearTimeout(this.timer);
    this.timer=window.setTimeout(()=>{void this.run(false);},2000);
  }
  store():Store {
    return {
      read:async path=>{const f=this.app.vault.getAbstractFileByPath(path);return f instanceof TFile?this.app.vault.read(f):f?'':null;},
      replace:async(path,expected,next)=>{
        const f=this.app.vault.getAbstractFileByPath(path);
        if(!(f instanceof TFile)) throw new Error('原文件已不存在。');
        await this.app.vault.process(f,current=>{if(current!==expected) throw new Error('整理期间原文发生变化，已停止写入。');return next;});
      },
      move:async(from,to)=>{
        if(this.app.vault.getAbstractFileByPath(to)) throw new Error('目标位置已存在同名文件。');
        const f=this.app.vault.getAbstractFileByPath(from);
        if(!(f instanceof TFile))throw new Error('待移动文件不存在。');
        await this.app.fileManager.renameFile(f,to);
      },
      persist:()=>this.save(),
    };
  }
  folders(s:Settings){
    return resolveFolders(s,this.app.vault.getAllLoadedFiles().filter(f=>f instanceof TFolder).map(f=>f.path));
  }
  checkConfiguration(s:Settings){
    validateSettings(s);
    const folders=this.folders(s);
    if(!folders.length)throw new Error('没有可归档的现有目录，请先在库里创建一个分类文件夹。');
    if(!(this.app.vault.getAbstractFileByPath(safePath(s.inbox)) instanceof TFolder))throw new Error('待整理目录不存在，请先创建或修改设置。');
    for(const folder of folders)if(!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder))throw new Error(`归档目录不存在：${folder}`);
    return folders;
  }
  async request(s:Settings,messages:{role:string;content:string}[]):Promise<string>{
    const base=s.endpoint.trim().replace(/\/+$/,'');
    const url=base.endsWith('/chat/completions')?base:base+'/chat/completions';
    let timeout:number|undefined;
    try {
      const response=await Promise.race([
        requestUrl({url,method:'POST',headers:{'Content-Type':'application/json',...(s.apiKey.trim()?{Authorization:'Bearer '+s.apiKey.trim()}:{})},body:JSON.stringify({model:s.model.trim(),messages,stream:false}),throw:false}),
        new Promise<never>((_,reject)=>{timeout=window.setTimeout(()=>reject(new Error('模型请求超过 60 秒，原文已保留。')),60000);}),
      ]);
      if(response.status===401 || response.status===403)throw new Error('模型认证失败，请检查 API Key 和服务权限。');
      if(response.status===429)throw new Error('模型服务限流或额度不足，请稍后手动重试。');
      if(response.status<200 || response.status>=300)throw new Error(`模型服务返回 HTTP ${response.status}，原文已保留。`);
      let json:any;
      try{json=response.json;}catch{throw new Error('服务返回的内容不是 JSON，请检查接口地址。');}
      const result=json?.choices?.[0]?.message?.content;
      if(typeof result!=='string' || !result.trim())throw new Error('模型返回为空或接口格式不兼容。');
      return result;
    }catch(e){
      const message=errorText(e);
      // Do not surface request headers, credentials, or remote response bodies.
      if(message.startsWith('模型') || message.startsWith('服务返回'))throw e;
      throw new Error('无法连接模型服务，请检查地址、网络与配置。');
    }finally{window.clearTimeout(timeout);}
  }
  async candidates(content:string,folders:string[],automatic=false):Promise<Candidate[]>{
    const list=this.app.vault.getMarkdownFiles().filter(f=>automatic?folders.includes(f.path.slice(0,f.path.lastIndexOf('/'))):folders.some(p=>under(f.path,p))).map(f=>{
      const cache=this.app.metadataCache.getFileCache(f);
      const fmTags=cache?.frontmatter?.tags;
      return {path:f.path,title:f.basename,tags:[...(cache?.tags?.map(t=>t.tag)??[]),...(Array.isArray(fmTags)?fmTags.filter(t=>typeof t==='string'):typeof fmTags==='string'?[fmTags]:[])]};
    });
    const ranked=rankCandidates(content,list);
    for(const c of ranked){
      const f=this.app.vault.getAbstractFileByPath(c.path);
      if(f instanceof TFile)c.excerpt=(await this.app.vault.cachedRead(f)).slice(0,1200);
    }
    return ranked;
  }
  async run(manual:boolean,onlyPath?:string){
    if(this.busy){if(manual)new Notice('已有整理任务正在运行。');return;}
    if(!this.config.enabled || this.stopped){if(manual)new Notice('请先在 Clip Tidy 设置中配置并启用整理。');return;}
    const s={...this.config}; const signature=JSON.stringify(s); let folders:string[];
    try{folders=this.checkConfiguration(s);}catch(e){this.updateStatus('需要配置');if(manual || s.onStartup)new Notice('Clip Tidy：'+errorText(e));return;}
    this.busy=true;this.pending=false;const gen=++this.generation;
    let done=0,review=0,failed=0,attempts=0,remaining=0;
    const files=this.app.vault.getMarkdownFiles().filter(f=>under(f.path,safePath(s.inbox)) && (!onlyPath || f.path===onlyPath)).sort((a,b)=>a.stat.ctime-b.stat.ctime || a.path.localeCompare(b.path));
    try{
      for(const file of files){
        if(this.stopped || gen!==this.generation || JSON.stringify(this.config)!==signature)break;
        const originalPath=file.path;
        this.activePath=originalPath;
        if(!under(originalPath,safePath(s.inbox)))continue;
        const content=await this.app.vault.read(file);
        if(!content.trim() || content.includes(marker))continue;
        const digest=await hash(content);
        if(this.data.outcomes[originalPath]?.hash===digest)continue;
        if(this.data.history.some(t=>(t.status==='applying'||t.status==='review'||t.status==='undoing')&&(t.original===originalPath||t.target===originalPath)))continue;
        if(attempts>=s.batchSize){remaining++;continue;}
        attempts++;this.updateStatus(`正在整理 ${attempts}/${s.batchSize}`);
        let transaction:Transaction|undefined;
        try{
          if(content.length>50000)throw new Error('原文超过 50,000 字符，保留待人工处理，避免截断整理。');
          const candidates=await this.candidates(content,folders,!s.destinations.trim());
          const raw=await this.request(s,buildMessages(content,originalPath,folders,candidates,s.instructions));
          if(this.stopped || gen!==this.generation || JSON.stringify(this.config)!==signature)break;
          const plan=parsePlan(raw,folders,candidates);
          // The original may have been edited or moved while the model was working.
          if(file.path!==originalPath || (await this.app.vault.read(file))!==content)throw new Error('等待 AI 时笔记已发生变化，本次不写入；下次重新整理。');
          if(plan.confidence<s.threshold){
            this.data.outcomes[originalPath]={plan,hash:digest,state:'review',message:`置信度 ${Math.round(plan.confidence*100)}%：${plan.reason}`,time:new Date().toISOString()};
            await this.save();review++;continue;
          }
          transaction=await this.archive(file,content,plan);
          delete this.data.outcomes[originalPath];await this.save();done++;
        }catch(e){
          if(transaction && transaction.status!=='done') transaction.status='review';
          this.data.outcomes[originalPath]={hash:digest,state:'error',message:errorText(e),time:new Date().toISOString()};
          await this.save();failed++;
          // Network/credentials/quota failures should not fan out into the rest of the batch.
          if(/模型|服务返回|连接/.test(errorText(e)))break;
        }
      }
      this.updateStatus(`归档 ${done} · 待确认 ${review} · 失败 ${failed}`);
      if(manual || attempts)new Notice(`Clip Tidy：已归档 ${done} 篇，待确认 ${review} 篇，失败 ${failed} 篇。${remaining?'另有 '+remaining+' 篇，下一次启动或手动整理时继续。':''}`);
    }catch{this.updateStatus('整理中断');new Notice('Clip Tidy：整理中断，原文备份和记录已保留。');}
    finally{
      this.busy=false;this.activePath=undefined;this.notifyHistory();
      // New clips arriving during a run get another batch; plugin's own writes do not.
      if(this.pending && gen===this.generation && !this.stopped){this.pending=false;this.schedule();}
    }
  }
  async archive(file:TFile,content:string,plan:Plan):Promise<Transaction>{
    if(!(this.app.vault.getAbstractFileByPath(plan.folder) instanceof TFolder))throw new Error('归档目录已被删除，原文保留。');
    const originalPath=file.path;
    let target=plan.folder+'/'+file.name;let n=2;
    while(this.app.vault.getAbstractFileByPath(target))target=plan.folder+'/'+file.basename+' ('+(n++)+').md';
    const links=plan.related.flatMap(path=>{
      const f=this.app.vault.getAbstractFileByPath(path);
      return f instanceof TFile && !/[\[\]|#^\n\r]/.test(f.path)?['[['+f.path.replace(/\.md$/,'')+']]']:[];
    });
    const id=crypto.randomUUID();
    const t:Transaction={id,original:originalPath,target,before:content,after:content+appendix(plan,links,id),status:'applying',time:new Date().toISOString(),reason:plan.reason};
    this.data.history.push(t);
    try{await applyTransaction(this.store(),t);}catch(e){if(t.status!=='done')t.status='review';await this.save();throw e;}
    return t;
  }
  async approve(path:string,o:Outcome){
    if(this.busy){new Notice('请等待当前整理结束。');return;}
    if(!o.plan)return;
    this.busy=true;this.activePath=path;
    try{
      const folders=this.checkConfiguration(this.config);
      const f=this.app.vault.getAbstractFileByPath(path);
      if(!(f instanceof TFile) || !under(path,safePath(this.config.inbox)))throw new Error('笔记已离开待整理目录。');
      const content=await this.app.vault.read(f);
      if(await hash(content)!==o.hash)throw new Error('原文已变化，请先重试生成新建议。');
      const candidates=o.plan.related.filter(p=>folders.some(folder=>under(p,folder))).map(p=>({path:p,title:p,tags:[]}));
      const plan=parsePlan(JSON.stringify(o.plan),folders,candidates);
      await this.archive(f,content,plan);
      delete this.data.outcomes[path];await this.save();new Notice('已按你确认的建议归档。');
    }catch(e){new Notice(errorText(e));}finally{this.busy=false;this.activePath=undefined;this.notifyHistory();}
  }
  async undo(t:Transaction){
    if(this.busy){new Notice('请等待当前整理结束后再撤销。');return;}
    this.busy=true;
    try{
      await undoTransaction(this.store(),t);
      this.data.outcomes[t.original]={hash:await hash(t.before),state:'undone',message:'已撤销，不会自动再次整理；点击重试可重新处理。',time:new Date().toISOString()};
      await this.save();new Notice('已恢复原文及原位置。');
    }catch(e){new Notice(errorText(e));}finally{this.busy=false;this.notifyHistory();}
  }
}

class BackupModal extends Modal{
  constructor(app:App,private text:string){super(app);}
  onOpen(){this.titleEl.setText('整理前的原文备份');this.contentEl.createEl('p',{text:'可复制恢复。此操作不会修改笔记。'});const box=this.contentEl.createEl('textarea',{cls:'clip-tidy-backup'});box.value=this.text;box.readOnly=true;}
  onClose(){this.contentEl.empty();}
}
class FolderModal extends Modal{
  constructor(app:App,private path:string,private back:()=>void){super(app);}
  onOpen(){
    this.titleEl.setText(this.path||'库根目录');
    const files=this.app.vault.getMarkdownFiles().filter(f=>folderOf(f.path)===this.path);
    this.contentEl.createEl('p',{text:`此目录中的 ${files.length} 篇笔记`,cls:'clip-tidy-muted'});
    for(const f of files.slice(0,100)){
      const b=this.contentEl.createEl('button',{text:titleOf(f.path),cls:'ct-folder-note'});
      b.addEventListener('click',()=>{this.close();void this.app.workspace.getLeaf(false).openFile(f);});
    }
    if(!files.length)this.contentEl.createEl('p',{text:'此目录下暂无直接存放的 Markdown 笔记。'});
    if(files.length>100)this.contentEl.createEl('p',{text:'仅展示前 100 篇，请在文件列表中查看其余笔记。'});
    const back=this.contentEl.createEl('button',{text:'返回整理记录'});
    back.addEventListener('click',()=>{this.close();this.back();});
  }
  onClose(){this.contentEl.empty();}
}
class HistoryModal extends Modal{
  private active:HistoryStatus='done';private query='';private limit=40;
  private tabs!:HTMLElement;private list!:HTMLElement;private activity!:HTMLElement;
  private organize!:HTMLButtonElement;private refs:EventRef[]=[];
  private expanded=new Set<string>();private opened=false;
  private changed=()=>{if(this.opened)this.draw();};
  constructor(app:App,private plugin:ClipTidy){super(app);}
  onOpen(){
    this.opened=true;this.modalEl.addClass('ct-history-modal');
    this.titleEl.setText('整理记录');this.contentEl.empty();
    const toolbar=this.contentEl.createDiv({cls:'ct-toolbar'});
    const intro=toolbar.createDiv();
    intro.createEl('span',{text:'收藏收件箱',cls:'ct-eyebrow'});
    const inbox=intro.createEl('button',{text:this.plugin.config.inbox,cls:'ct-text-link'});
    inbox.addEventListener('click',()=>this.browse(this.plugin.config.inbox));
    const actions=toolbar.createDiv({cls:'ct-toolbar-actions'});
    this.organize=this.button(actions,'整理待处理',async()=>{await this.plugin.run(true);},true);
    this.button(actions,'刷新',()=>this.draw());
    this.tabs=this.contentEl.createDiv({cls:'ct-tabs'});this.tabs.setAttribute('role','tablist');this.tabs.setAttribute('aria-label','按整理状态筛选');
    const search=this.contentEl.createEl('input',{type:'search',placeholder:'搜索文章标题或目录…',cls:'ct-search'});
    search.value=this.query;search.setAttribute('aria-label','搜索整理记录');
    search.addEventListener('input',()=>{this.query=search.value;this.limit=40;this.draw();});
    this.activity=this.contentEl.createDiv({cls:'ct-activity'});this.activity.setAttribute('aria-live','polite');
    this.list=this.contentEl.createDiv({cls:'ct-record-list'});this.list.id='ct-history-panel';this.list.setAttribute('role','tabpanel');
    this.plugin.historyListeners.add(this.changed);
    this.refs.push(this.app.vault.on('create',this.changed),this.app.vault.on('delete',this.changed),this.app.vault.on('rename',this.changed));
    this.draw();
  }
  button(parent:HTMLElement,label:string,action:()=>void|Promise<void>,primary=false){
    const b=parent.createEl('button',{text:label,cls:primary?'mod-cta':''});
    b.addEventListener('click',async()=>{b.disabled=true;try{await action();}catch(e){new Notice(errorText(e));}finally{b.disabled=false;if(this.opened)this.draw();}});
    return b;
  }
  browse(path:string){this.close();new FolderModal(this.app,path,()=>this.open()).open();}
  openNote(path:string){
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!(file instanceof TFile)){new Notice('这篇笔记已被移动或删除；可从原文备份找回。');return;}
    this.close();void this.app.workspace.getLeaf(false).openFile(file);
  }
  async retry(path:string){
    const p=this.plugin;if(p.busy){new Notice('请等待当前整理结束。');return;}
    if(p.data.history.some(t=>['applying','review','undoing'].includes(t.status)&&t.original===path)){new Notice('请先恢复这篇笔记的未完成写入。');return;}
    delete p.data.outcomes[path];await p.save();await p.run(true,path);
  }
  draw(){
    const p=this.plugin;
    const rows=historyRows(this.app.vault.getMarkdownFiles().map(f=>f.path),p.config.inbox,p.data.outcomes,p.data.history);
    const states:HistoryStatus[]=['done','pending','review','error'];
    const labels:Record<HistoryStatus,string>={done:'已整理',pending:'未整理',review:'待确认',error:'失败'};
    this.organize.disabled=p.busy;
    this.tabs.empty();
    for(const state of states){
      const b=this.tabs.createEl('button',{cls:'ct-tab'+(state===this.active?' is-active':'')});
      b.setAttribute('role','tab');b.setAttribute('aria-selected',String(state===this.active));b.setAttribute('aria-controls',this.list.id);
      b.tabIndex=state===this.active?0:-1;
      b.createSpan({text:labels[state]});b.createSpan({text:String(rows.filter(r=>r.status===state).length),cls:'ct-count'});
      b.addEventListener('click',()=>{this.active=state;this.limit=40;this.draw();this.tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();});
      b.addEventListener('keydown',event=>{
        const index=states.indexOf(state);let next=index;
        if(event.key==='ArrowRight')next=(index+1)%states.length;else if(event.key==='ArrowLeft')next=(index+states.length-1)%states.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=states.length-1;else return;
        event.preventDefault();this.active=states[next];this.limit=40;this.draw();this.tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
      });
    }
    const q=this.query.toLocaleLowerCase().trim();
    const visible=rows.filter(r=>r.status===this.active && (!q || `${r.title} ${r.original} ${r.destination??''}`.toLocaleLowerCase().includes(q)));
    this.activity.setText(p.busy?'正在整理 · '+(p.activePath?titleOf(p.activePath):'请稍候'):`${labels[this.active]} ${visible.length} 篇${q?' · 已筛选':''}`);
    this.list.empty();
    if(!visible.length){
      const empty=this.list.createDiv({cls:'ct-empty'});
      empty.createEl('strong',{text:q?'没有匹配的文章':{done:'还没有已整理的文章',pending:'收件箱已处理完毕',review:'没有需要确认的文章',error:'没有整理失败的文章'}[this.active]});
      empty.createEl('p',{text:q?'换个标题或目录关键词试试。':{done:'整理完成后，可以在这里查看每篇文章的去向。',pending:'新的收藏进入待整理目录后，会出现在这里。',review:'分类把握不足或写入异常的文章会保留在这里。',error:'模型请求失败的文章会留在原处，可在这里重试。'}[this.active]});
    }
    for(const row of visible.slice(0,this.limit))this.card(row,labels);
    if(visible.length>this.limit)this.button(this.list,`再显示 ${Math.min(40,visible.length-this.limit)} 篇`,()=>{this.limit+=40;});
  }
  card(row:HistoryRow,labels:Record<HistoryStatus,string>){
    const p=this.plugin;const card=this.list.createEl('article',{cls:'ct-record'});
    const heading=card.createDiv({cls:'ct-record-heading'});
    const title=heading.createEl('button',{text:row.title,cls:'ct-note-title'});title.title=row.current;title.addEventListener('click',()=>this.openNote(row.current));
    heading.createSpan({text:row.restored?'已撤销':row.transaction && row.transaction.status!=='done'?'需要检查':labels[row.status],cls:'ct-status ct-status-'+row.status});
    const route=card.createDiv({cls:'ct-route'});
    const location=(label:string,path:string|undefined)=>{
      const part=route.createDiv({cls:'ct-location'});part.createSpan({text:label,cls:'ct-eyebrow'});
      if(path!==undefined){const b=part.createEl('button',{text:path||'库根目录',cls:'ct-folder-link'});b.title=path||'库根目录';b.setAttribute('aria-label','浏览目录：'+(path||'库根目录'));b.addEventListener('click',()=>this.browse(path));}
      else part.createSpan({text:'等待 AI 分类',cls:'ct-awaiting'});
    };
    location(row.status==='done'?'原目录':'当前目录',folderOf(row.original));
    location(row.status==='done'?'已归档至':row.status==='review'?'建议归档至':'目标目录',row.destination);
    const meta=card.createDiv({cls:'ct-record-meta'});
    if(row.time)meta.createSpan({text:new Date(row.time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})});
    if(row.outcome?.plan)meta.createSpan({text:'分类置信度 '+Math.round(row.outcome.plan.confidence*100)+'%'});
    if(row.restored)meta.createSpan({text:'已恢复原位 · 自动整理已暂停'});
    if(row.missing)meta.createSpan({text:'文件已移动或删除 · 原文备份仍可用'});
    if(row.status==='error')card.createEl('p',{text:row.reason,cls:'ct-error-message'});
    if(row.reason && row.status!=='error'){
      const detail=card.createEl('details',{cls:'ct-details'});detail.open=this.expanded.has(row.id);
      detail.createEl('summary',{text:row.summary?'查看摘要与归档理由':'查看归档理由'});
      if(row.summary){detail.createEl('h4',{text:'摘要'});detail.createEl('p',{text:row.summary});}
      detail.createEl('h4',{text:row.transaction?.status==='review'?'需要检查':'归档理由'});
      detail.createEl('p',{text:row.outcome?.plan?.reason??row.reason});
      detail.addEventListener('toggle',()=>{if(detail.open)this.expanded.add(row.id);else this.expanded.delete(row.id);});
    }
    const actions=card.createDiv({cls:'ct-record-actions'});
    this.button(actions,'打开文章',()=>this.openNote(row.current)).disabled=!!row.missing;
    if(row.transaction){
      const t=row.transaction;
      this.button(actions,'原文备份',()=>new BackupModal(this.app,t.before).open());
      if(['done','review','applying'].includes(t.status))this.button(actions,'撤销归档',async()=>{await p.undo(t);}).disabled=p.busy;
    }else{
      this.button(actions,row.status==='pending'?'整理这篇':'重新分析',()=>this.retry(row.original)).disabled=p.busy;
      if(row.status==='review' && row.outcome?.plan)this.button(actions,'确认归档',()=>p.approve(row.original,row.outcome!),true).disabled=p.busy;
    }
  }
  onClose(){this.opened=false;this.plugin.historyListeners.delete(this.changed);for(const ref of this.refs)this.app.vault.offref(ref);this.refs=[];this.contentEl.empty();}
}
class TidySettings extends PluginSettingTab{
  constructor(app:App,private plugin:ClipTidy){super(app,plugin);}
  display(){
    const el=this.containerEl;el.empty();const p=this.plugin;const s=p.config;
    el.createEl('h2',{text:'Clip Tidy · 收藏自动整理'});
    el.createEl('p',{text:'打开 Obsidian 后整理待整理目录。原文保留，AI 摘要附在文末；只归档到你允许的现有目录。'});
    el.createEl('p',{cls:'clip-tidy-muted',text:'启用后，新收藏全文、允许的目录名及最多 6 篇相关笔记各 1,200 字符会发送到你配置的模型服务。API Key 与原文备份保存在此插件的本地 data.json 中，请勿公开分享该文件。'});
    let refreshFolders=()=>{};
    const text=(name:string,desc:string,key:'inbox'|'endpoint'|'model'|'apiKey',placeholder:string)=>{
      new Setting(el).setName(name).setDesc(desc).addText(t=>{
        t.setPlaceholder(placeholder).setValue(s[key]);if(key==='apiKey')t.inputEl.type='password';
        t.onChange(async v=>{s[key]=v;await p.save();if(key==='inbox')refreshFolders();});
      });
    };
    text('待整理目录','相对于库根目录的路径；需先创建该文件夹。','inbox','待整理');
    let folderBox:HTMLTextAreaElement;
    let describeFolders=()=>{};
    const folderSetting=new Setting(el).setName('归档目录')
      .addTextArea(t=>{
        folderBox=t.inputEl;
        folderBox.rows=5;
        folderBox.wrap='off';
        folderBox.addClass('clip-tidy-folders');
        folderBox.setAttribute('aria-label','归档目录，每行一个，可直接编辑');
        t.setPlaceholder('自动读取现有目录；也可每行填写一个目录');
        t.onChange(async value=>{
          s.destinations=value;
          describeFolders();
          await p.save();
        });
        folderBox.addEventListener('blur',()=>{if(!s.destinations.trim())refreshFolders();});
      })
      .addExtraButton(b=>b.setIcon('refresh-cw').setTooltip('恢复自动识别目录').onClick(async()=>{
        s.destinations='';
        refreshFolders();
        await p.save();
      }));
    folderSetting.settingEl.addClass('clip-tidy-folder-setting');
    describeFolders=()=>{
      try{
        const folders=p.folders(s);
        folderSetting.setDesc((s.destinations.trim()?'已选择 ':'自动识别 ')+folders.length+' 个目录。可直接编辑，每行一个；点击右侧刷新恢复自动识别。');
      }catch(e){folderSetting.setDesc(errorText(e));}
    };
    refreshFolders=()=>{
      describeFolders();
      try{folderBox.value=s.destinations.trim()?s.destinations:p.folders(s).join('\n');}
      catch{folderBox.value=s.destinations;}
    };
    refreshFolders();
    text('模型接口地址','兼容 OpenAI Chat Completions；支持本机服务。','endpoint','https://api.openai.com/v1');
    text('模型名称','填写模型服务提供的准确名称。','model','填写你的模型名称');
    text('API Key','本地模型不需要认证时可留空。密钥以明文存于插件配置。','apiKey','');
    new Setting(el).setName('测试模型连接').setDesc('仅发送一句测试文本，不发送任何笔记。').addButton(b=>b.setButtonText('测试连接').onClick(async()=>{
      b.setDisabled(true);
      try{validateSettings(s);await p.request({...s},[{role:'user',content:'Reply with OK.'}]);new Notice('模型连接成功。');}catch(e){new Notice(errorText(e));}finally{b.setDisabled(false);}
    }));
    new Setting(el).setName('整理偏好').setDesc('例如：“Agent 工具放资料/AI；商业案例放资料/产品。摘要不超过三句话。”').addTextArea(t=>{t.setValue(s.instructions).onChange(async v=>{s.instructions=v;await p.save();});t.inputEl.rows=4;});
    new Setting(el).setName('自动归档最低置信度').setDesc('模型自评的分类把握程度，不代表准确率保证；低于此值保留原文等待确认。').addSlider(t=>t.setLimits(0.5,1,0.05).setValue(s.threshold).setDynamicTooltip().onChange(async v=>{s.threshold=v;await p.save();}));
    new Setting(el).setName('每批最多处理').setDesc('限制一次启动或手动整理的请求数量。').addDropdown(d=>d.addOptions({'5':'5 篇','10':'10 篇','20':'20 篇'}).setValue(String(s.batchSize)).onChange(async v=>{s.batchSize=Number(v);await p.save();}));
    new Setting(el).setName('启动时整理').addToggle(t=>t.setValue(s.onStartup).onChange(async v=>{s.onStartup=v;await p.save();}));
    new Setting(el).setName('新收藏自动整理').setDesc('Obsidian 打开期间，待整理目录新增或修改 Markdown 时自动排队。').addToggle(t=>t.setValue(s.watch).onChange(async v=>{s.watch=v;await p.save();}));
    new Setting(el).setName('启用 AI 整理').setDesc('完成配置后开启，即同意按上述范围向模型服务发送内容。').addToggle(t=>t.setValue(s.enabled).onChange(async v=>{
      if(v){try{p.checkConfiguration(s);}catch(e){new Notice(errorText(e));t.setValue(false);return;}}
      s.enabled=v;if(!v)p.stop();await p.save();p.updateStatus();if(v&&s.onStartup)p.schedule();
    }));
    new Setting(el).setName('操作').addButton(b=>b.setButtonText('立即整理').setCta().onClick(()=>{void p.run(true);})).addButton(b=>b.setButtonText('查看记录 / 撤销').onClick(()=>new HistoryModal(this.app,p).open()));
  }
}
