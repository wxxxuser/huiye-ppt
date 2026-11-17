import { useCallback, useEffect, useRef, useState } from 'react';
import type { Brief, Deck, Layout, Outline, Platform, Slide, ThemeId, UsageRecord, WorkspaceDraft } from './types';
import { connectPlatform } from './platform';
import { checkSlide, createDeck, LIMITS, splitSources, validateBrief, validateStoredDeck } from './domain';
import { generateDeck, generateOutline, rewriteSlide, usageFromError } from './ai';
import { SAMPLE_BRIEF, SAMPLE_IMAGES, makeDemoOutline, makeDemoSlides, makeSampleDeck } from './sample';
import { getSlideTypography, THEMES, TYPOGRAPHY_RANGES } from './presentation';
import { SlidePreview } from './components/SlidePreview';
import { Icon } from './components/Icon';
import { applyDeckEdit, emptyWorkspace, hasWorkspaceContent, validateWorkspace, workspaceFromDeck } from './workspace';
import { breakHistoryGroup, commitHistory, createHistory, redoHistory, replacePresent, undoHistory } from './history';
import { addSlide, deleteSlide, duplicateSlide } from './page-operations';
import { blobToDataUrl, inspectImageBlob, prepareImage } from './images';
import { useSlideImages } from './useSlideImages';
import type { ImportedDraft } from './backup';
import { deckAssets } from './image-assets';

const LAYOUTS: Record<Layout, string> = {cover:'封面',bullets:'要点',split:'双栏',steps:'步骤',closing:'收尾',image:'图文'};
const labelForOperation = {outline:'生成大纲',deck:'生成幻灯片',rewrite:'单页改写'};
type Stage = 'brief' | 'outline' | 'editor';
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'invalid';

const errorMessage = (e: unknown) => e instanceof Error ? e.message : '操作未完成，请稍后重试。';
const sameBrief = (a: Brief | null,b: Brief) => !!a && JSON.stringify(a)===JSON.stringify(b);
const simulationUsage = (operation: UsageRecord['operation']): UsageRecord => ({id:crypto.randomUUID(),at:new Date().toISOString(),operation,simulated:true,quotaConsumed:0});

export default function App() {
  const [platform,setPlatform]=useState<Platform|null>(null);
  const [bootError,setBootError]=useState('');
  const [bootKey,setBootKey]=useState(0);
  const [loading,setLoading]=useState(true);
  const [hydrated,setHydrated]=useState(false);
  const [storageBlocked,setStorageBlocked]=useState(false);
  const [startupDraft,setStartupDraft]=useState<WorkspaceDraft|null>(null);
  const [history,setHistory]=useState(()=>createHistory(emptyWorkspace()));
  const workspace=history.present;
  const {brief,outlineBrief,sources,outline,deck,stage,selected,usage}=workspace;
  const [busy,setBusy]=useState('');
  const busyRef=useRef(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [saveState,setSaveState]=useState<SaveState>('idle');
  const [saveError,setSaveError]=useState('');
  const [saveRetry,setSaveRetry]=useState(0);
  const [usageOpen,setUsageOpen]=useState(false);
  const [editorTab,setEditorTab]=useState<'content'|'sources'>('content');
  const [rewriteInstruction,setRewriteInstruction]=useState('');
  const [pendingImport,setPendingImport]=useState<(ImportedDraft&{sample?:boolean})|null>(null);
  const [resetOpen,setResetOpen]=useState(false);
  const [reloadOpen,setReloadOpen]=useState(false);
  const [sampleImagesOpen,setSampleImagesOpen]=useState(false);
  const importRef=useRef<HTMLInputElement>(null);
  const materialRef=useRef<HTMLInputElement>(null);
  const imageRef=useRef<HTMLInputElement>(null);
  const imageResources=useSlideImages(deck,platform);
  const saveQueue=useRef<Promise<void>>(Promise.resolve());

  const change=(update:(value:WorkspaceDraft)=>WorkspaceDraft,group?:string)=>{
    setHistory(current=>commitHistory(current,update(current.present),group));
  };
  const typingGroup=(name:string)=>document.activeElement?.matches('input,textarea')?name:undefined;
  const setBrief=(value:Brief|((current:Brief)=>Brief))=>change(current=>({...current,brief:typeof value==='function'?value(current.brief):value}),typingGroup('brief'));
  const setOutline=(value:Outline)=>change(current=>({...current,outline:value}),typingGroup('outline'));
  const setStage=(value:Stage)=>setHistory(current=>replacePresent(current,{...current.present,stage:value}));
  const setSelected=(value:number)=>setHistory(current=>replacePresent(current,{...current.present,selected:value}));
  const restoreDeck=useCallback((value:Deck) => {
    setHistory(createHistory(workspaceFromDeck(value)));setStartupDraft(null);setRewriteInstruction('');setError('');
  },[]);
  const undo=useCallback(()=>{if(busyRef.current)return;setHistory(undoHistory);setRewriteInstruction('');setError('');},[]);
  const redo=useCallback(()=>{if(busyRef.current)return;setHistory(redoHistory);setRewriteInstruction('');setError('');},[]);
  useEffect(()=>{
    const shortcut=(event:KeyboardEvent)=>{
      if(event.isComposing||event.altKey||!(event.ctrlKey||event.metaKey)||usageOpen||pendingImport||resetOpen||reloadOpen||sampleImagesOpen||startupDraft||loading)return;
      if(event.target instanceof HTMLElement&&event.target.closest('[data-native-undo]'))return;
      const key=event.key.toLowerCase();
      if(key==='z'||(key==='y'&&!event.shiftKey)){
        event.preventDefault();if(key==='y'||event.shiftKey)redo();else undo();
      }
    };
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[undo,redo,usageOpen,pendingImport,resetOpen,reloadOpen,sampleImagesOpen,startupDraft,loading]);

  useEffect(()=>{
    let active=true;
    setLoading(true);setBootError('');setHydrated(false);
    (async()=>{
      const host=await connectPlatform();
      if(!active)return;
      setPlatform(host);
      try {
        const value=await host.loadDraft();
        if(!active)return;
        if(value!=null){
          const saved=validateWorkspace(value);
          if(!saved)throw new Error('已有草稿的格式无法识别。为保留原稿，暂不自动覆盖；你仍可编辑并导出文件。');
          setHistory(createHistory(emptyWorkspace()));
          setStartupDraft(hasWorkspaceContent(saved)?saved:null);
        }
        setStorageBlocked(false);
      } catch(e){if(active){setStorageBlocked(true);setError('读取草稿失败：'+errorMessage(e));}}
      if(active){setHydrated(true);setLoading(false);}
    })().catch(e=>{if(active){setBootError(errorMessage(e));setLoading(false);}});
    return()=>{active=false;};
  },[bootKey]);

  useEffect(()=>{
    // The saved draft stays untouched until the user chooses to resume or replace it.
    if(!platform||!hydrated||storageBlocked||startupDraft)return;
    const current=validateWorkspace(workspace);
    if(!current){setSaveState('invalid');return;}
    setSaveState('saving');
    let active=true;
    const timer=setTimeout(()=>{
      // Serialize writes so an older, slower request cannot overwrite a newer draft.
      saveQueue.current=saveQueue.current.catch(()=>{}).then(async()=>{
        if(!active)return;
        await platform.saveDraft(current);
        if(active){setSaveState('saved');setSaveError('');}
      }).catch(e=>{if(active){setSaveState('error');setSaveError(errorMessage(e));}});
    },650);
    return()=>{active=false;clearTimeout(timer);};
  },[workspace,platform,hydrated,storageBlocked,startupDraft,saveRetry]);

  useEffect(()=>{
    if(!platform)return;
    const timer=setTimeout(()=>{void platform.setTitle(deck?`${deck.title} · 汇页PPT`:'汇页PPT').catch(()=>{});},1000);
    return()=>clearTimeout(timer);
  },[deck?.title,platform]);

  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),6000);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{
    const protect=(event:BeforeUnloadEvent)=>{if(busy||saveState==='saving'||saveState==='error'||saveState==='invalid'){event.preventDefault();}};
    window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);
  },[busy,saveState]);

  const appendUsage=(record:UsageRecord)=>{
    setHistory(current=>replacePresent(current,{...current.present,usage:[...current.present.usage,record]}));
  };
  const run=async(label:string,fn:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(label);setError('');setNotice('');
    try{await fn();}catch(e){const consumed=usageFromError(e);if(consumed)appendUsage(consumed);setError(errorMessage(e));}
    finally{busyRef.current=false;setBusy('');}
  };
  const updateDeck=(update:(current:Deck)=>Deck,group?:string)=>change(current=>{
    if(!current.deck)return current;
    const next={...update(current.deck),updatedAt:new Date().toISOString()};
    return applyDeckEdit(current,next);
  },group);
  const editSlide=(patch:Partial<Slide>)=>updateDeck(current=>{
    const slides=current.slides.map((slide,i)=>i===selected?{...slide,...patch}:slide);
    const updated=slides[selected];
    return {...current,slides,outline:{...current.outline,slides:current.outline.slides.map(item=>item.id===updated.id?{...item,title:updated.title,keyMessage:updated.subtitle,layout:updated.layout,sourceIds:updated.sourceIds}:item)}};
  },typingGroup(`slide:${deck?.slides[selected]?.id}:${Object.keys(patch).join()}`));
  const uploadImage=(file?:File)=>{
    if(imageRef.current)imageRef.current.value='';
    if(!file||!platform||!deck)return;
    void run('正在保存图片…',async()=>{
      const prepared=await prepareImage(file);
      const asset=await platform.saveImage(prepared);
      editSlide({layout:'image',image:{asset,fit:'contain',side:deck.slides[selected].image?.side??'left'}});
      setNotice('图片已加入。可调整图文位置，并随 PPTX 导出。');
    });
  };
  const addSampleImage=(item:typeof SAMPLE_IMAGES[number])=>void run('正在添加示例图片…',async()=>{
    if(!platform||!deck)return;
    const response=await fetch(`${import.meta.env.BASE_URL}examples/${item.file}`);
    if(!response.ok)throw new Error('示例图片读取失败，请稍后重试。');
    const blob=await response.blob();
    const asset=await platform.saveImage(await prepareImage(new File([blob],item.file,{type:blob.type})));
    editSlide({layout:'image',image:{asset,fit:'contain',side:deck.slides[selected].image?.side??'left'}});
    setSampleImagesOpen(false);setNotice('示例图片已加入当前页，正文保持不变。');
  });
  const sampleWithImages=async(value:Deck):Promise<Deck>=>{
    if(!platform)throw new Error('请等待平台连接完成。');
    const next=structuredClone(value);
    for(const item of SAMPLE_IMAGES){
      const response=await fetch(`${import.meta.env.BASE_URL}examples/${item.file}`);
      if(!response.ok)throw new Error('示例图片读取失败，请稍后重试。');
      const blob=await response.blob();
      const prepared=await prepareImage(new File([blob],item.file,{type:blob.type}));
      const asset=await platform.saveImage(prepared);
      next.slides[item.slideIndex]={...next.slides[item.slideIndex],layout:'image',image:{asset,fit:'contain',side:'left'}};
      next.outline.slides[item.slideIndex]={...next.outline.slides[item.slideIndex],layout:'image'};
    }
    return next;
  };
  const openSample=()=>{
    const candidate={deck:makeSampleDeck(),images:new Map<string,Blob>(),sample:true};
    if(startupDraft||hasWorkspaceContent(workspace))setPendingImport(candidate);
    else void run('正在打开图文示例…',async()=>{restoreDeck(await sampleWithImages(candidate.deck));setNotice('已打开咖啡店复盘示例，经营数据为虚构，照片仅作场景示意。');});
  };
  const acceptImport=()=>void run('正在打开草稿…',async()=>{
    if(!pendingImport||!platform)return;
    let next=structuredClone(pendingImport.deck);
    if(pendingImport.sample)next=await sampleWithImages(next);
    else for(const asset of deckAssets(next)){
      const bundled=pendingImport.images.get(asset.id);
      if(bundled){
        const info=await inspectImageBlob(bundled);
        if(info.mimeType!==asset.mimeType||info.width!==asset.width||info.height!==asset.height)throw new Error('备份中的图片格式或尺寸与记录不一致。');
        const bitmap=await createImageBitmap(bundled);
        try{if(bitmap.width!==asset.width||bitmap.height!==asset.height)throw new Error('备份中的图片尺寸不匹配。');}finally{bitmap.close();}
        const stored=await platform.saveImage({blob:bundled,name:asset.name,width:asset.width,height:asset.height});
        next.slides=next.slides.map(slide=>slide.image?.asset.id===asset.id?{...slide,image:{...slide.image,asset:stored}}:slide);
      }else{
        try{await platform.loadImage(asset);}catch{throw new Error('草稿中的图片无法读取，请导入包含图片的 .huiye.zip 备份。');}
      }
    }
    restoreDeck(next);setPendingImport(null);setNotice('草稿和图片已打开。');
  });
  const moveSlide=(offset:number)=>{
    if(!deck)return;const to=selected+offset;if(to<0||to>=deck.slides.length)return;
    change(current=>{
      const original=current.deck!;const slides=[...original.slides];[slides[selected],slides[to]]=[slides[to],slides[selected]];
      const next={...original,slides,outline:{...original.outline,slides:slides.map(slide=>original.outline.slides.find(item=>item.id===slide.id)!)},updatedAt:new Date().toISOString()};
      return {...applyDeckEdit(current,next),selected:to};
    });
  };
  const operatePage=(operation:'add'|'copy'|'delete')=>{
    if(!deck||busyRef.current)return;
    try{
      const next=({add:addSlide,copy:duplicateSlide,delete:deleteSlide}[operation])(deck,selected);
      change(current=>({...applyDeckEdit(current,next),selected:operation==='delete'?Math.min(selected,next.slides.length-1):selected+1}));
      setRewriteInstruction('');setError('');setEditorTab('content');
    }catch(e){setError(errorMessage(e));}
  };
  const onOutline=()=>void run('正在生成大纲…',async()=>{
    if(!platform)return;
    const problem=validateBrief(brief);if(problem)throw new Error(problem);
    const material=splitSources(brief.source);
    const result=platform.mode==='demo'?{outline:makeDemoOutline(brief,material),usage:simulationUsage('outline')}:await generateOutline(platform,brief,material);
    change(current=>({...current,sources:material,outline:result.outline,outlineBrief:{...brief},usage:[...current.usage,result.usage],stage:'outline'}));
  });
  const onDeck=()=>void run('正在生成幻灯片…',async()=>{
    if(!platform||!outline||!outlineBrief)return;
    if(!sameBrief(outlineBrief,brief))throw new Error('材料或目标已修改，请先重新生成大纲。');
    if(outline.slides.length!==brief.slideCount||outline.slides.some(item=>!/^slide-(?:[1-9]|10)$/.test(item.id)))throw new Error('此大纲已随成稿增删页面。请在编辑页继续修改；需要重新生成整稿时，请先返回材料重新生成大纲。');
    if(!outline.title.trim()||outline.slides.some(item=>!item.title.trim()||!item.keyMessage.trim()||!item.sourceIds.length))throw new Error('请先补全大纲标题、每页核心信息和材料引用。');
    const result=platform.mode==='demo'?{slides:makeDemoSlides(brief,outline,sources),usage:simulationUsage('deck')}:await generateDeck(platform,brief,outline,sources);
    const allUsage=[...usage,result.usage];
    const generated=createDeck(brief,outline,result.slides,sources,allUsage);
    change(current=>({...current,deck:generated,outline:generated.outline,usage:allUsage,selected:0,stage:'editor'}));
  });
  const onRewrite=()=>void run('正在改写当前页…',async()=>{
    if(!platform||!deck)return;
    if(platform.mode==='demo')throw new Error('当前为本地演示。单页 AI 改写需在 Anna 中使用；你可以直接编辑右侧文字。');
    if(!rewriteInstruction.trim())throw new Error('请先描述这页想怎么改，例如“更简洁，突出结论”。');
    if(!deck.slides[selected].sourceIds.length)throw new Error('请先在“材料出处”中关联材料，再使用 AI 改写。');
    const original=deck;
    const result=await rewriteSlide(platform,deck.brief,deck.slides[selected],deck.sourceBlocks,rewriteInstruction.trim());
    const next={...original,slides:original.slides.map((slide,i)=>i===selected?result.slide:slide),outline:{...original.outline,slides:original.outline.slides.map(item=>item.id===result.slide.id?{...item,title:result.slide.title,keyMessage:result.slide.subtitle,layout:result.slide.layout,sourceIds:result.slide.sourceIds}:item)},updatedAt:new Date().toISOString()};
    change(current=>({...applyDeckEdit(current,next),usage:[...current.usage,result.usage]}));
    setRewriteInstruction('');setNotice('当前页已改写，可用撤销恢复；已发生的 AI 用量会保留。');
  });
  const exportDeck=()=>void run('正在生成可编辑 PPTX…',async()=>{
    if(!deck||!platform)return;
    const invalid=validateStoredDeck(deck);if(!invalid||!deck.title.trim()||deck.slides.some(slide=>!slide.title.trim()||slide.body.some(item=>!item.trim())))throw new Error('请先补全文稿标题、页面标题和空白要点，再导出。');
    const {buildPptx,getPptxFilename}=await import('./export-pptx');
    const imageData:Record<string,string>={};
    for(const asset of deckAssets({...deck,slides:deck.slides.filter(slide=>slide.layout==='image')}))imageData[asset.id]=await blobToDataUrl(await imageResources.read(asset));
    const bytes=await buildPptx(deck,imageData);
    await platform.saveFile(bytes,getPptxFilename(deck),'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    setNotice('PPTX 已生成并提交下载，请查看浏览器下载列表。文字与形状可继续编辑。');
  });
  const exportJson=()=>void run('正在保存草稿备份…',async()=>{
    if(!deck||!platform)return;
    if(deckAssets(deck).length){
      const {buildBackup}=await import('./backup');
      await platform.saveFile(await buildBackup(deck,imageResources.read),`${safeFilename(deck.title)}.huiye.zip`,'application/zip');
    }else await platform.saveFile(new TextEncoder().encode(JSON.stringify(deck,null,2)),`${safeFilename(deck.title)}.huiye.json`,'application/json');
    setNotice('草稿备份已提交下载；含图文稿的 ZIP 包内包含图片，可导入继续编辑。');
  });
  const importDraft=async(file?:File)=>{
    if(!file)return;
    try{
      if(/\.zip$/i.test(file.name)){
        if(file.size>20*1024*1024)throw new Error('草稿备份不能超过 20 MB。');
        const {readBackup}=await import('./backup');setPendingImport(await readBackup(new Uint8Array(await file.arrayBuffer())));
      }else{
        if(file.size>512_000)throw new Error('JSON 草稿不能超过 500 KB，请选择 .huiye.zip 图片备份。');
        const parsed=validateStoredDeck(JSON.parse(await file.text()));if(!parsed)throw new Error('无法识别这份草稿，请导入汇页导出的 JSON 或 ZIP 文件。');
        setPendingImport({deck:parsed,images:new Map()});
      }
    }catch(e){setError(errorMessage(e));}
    if(importRef.current)importRef.current.value='';
  };
  const importMaterial=async(file?:File)=>{
    if(!file)return;
    try{if(!/\.(txt|md)$/i.test(file.name))throw new Error('当前支持 UTF-8 编码的 .txt 或 .md 文件。');if(file.size>80_000)throw new Error('文件过大，请先摘取与演示相关的材料。');const content=await file.text();if(content.length>LIMITS.sourceMax)throw new Error(`材料超过 ${LIMITS.sourceMax} 字，请先精简后导入。`);setBrief(value=>({...value,source:content}));setNotice('材料已读入，尚未发送给 AI。');}catch(e){setError(errorMessage(e));}
    if(materialRef.current)materialRef.current.value='';
  };
  const totalCu=usage.reduce((sum,u)=>sum+(u.quotaConsumed??0),0);
  const knownCu=usage.some(u=>!u.simulated&&typeof u.quotaConsumed==='number');
  const realCalls=usage.filter(u=>!u.simulated).length;
  const currentSlide=deck?.slides[Math.min(selected,(deck?.slides.length||1)-1)];
  const currentIssues=currentSlide&&deck?checkSlide(currentSlide,deck.sourceBlocks):[];
  const label=platform?.mode==='demo'?'本地演示':'Anna 已连接';
  const disabled=!!busy;

  if(loading)return <div className="boot-screen"><div className="brand-mark"><Icon name="slides" size={29}/></div><h1>汇页PPT</h1><p><span className="spinner"/>正在准备工作台…</p></div>;
  if(bootError)return <div className="boot-screen"><Icon name="info" size={32}/><h1>暂时无法连接 Anna</h1><p className="boot-error">{bootError}</p><button className="button primary" onClick={()=>setBootKey(k=>k+1)}>重新连接</button><p className="subtle">请从 Anna App 窗口或官方本地开发环境打开此应用。</p></div>;

  return <div className={`app-shell stage-${stage}`} onBlurCapture={()=>setHistory(breakHistoryGroup)}>
    <header className="app-header">
      <button className="brand" onClick={()=>deck?setResetOpen(true):setStage('brief')} aria-label="汇页PPT 首页" disabled={disabled}><span>汇页<span className="brand-ppt">PPT</span></span></button>
      <div className="header-actions"><span className={`connection ${platform?.mode}`}><i/>{label}</span><button className="text-button usage-button" aria-label="AI 用量记录" onClick={()=>setUsageOpen(true)}><Icon name="clock" size={16}/><span>{knownCu?`${totalCu.toFixed(2)} CU`:'用量'}</span></button><button className="text-button" onClick={openSample} disabled={disabled}>打开示例</button><button className="text-button import-button" aria-label="导入汇页草稿" onClick={()=>importRef.current?.click()} disabled={disabled}><Icon name="upload" size={16}/><span>导入汇页草稿</span></button>{<button className="text-button new-document" disabled={disabled} onClick={()=>setResetOpen(true)}><Icon name="plus" size={16}/><span>新建</span></button>}</div>
    </header>
    <input ref={importRef} type="file" accept=".json,.zip,application/json,application/zip" hidden onChange={e=>void importDraft(e.target.files?.[0])}/>
    <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>uploadImage(e.target.files?.[0])}/>
    <input ref={materialRef} type="file" accept=".txt,.md,text/plain,text/markdown" hidden onChange={e=>void importMaterial(e.target.files?.[0])}/>
    {!startupDraft&&<><nav className="workflow" aria-label="制作进度">{(['brief','outline','editor'] as Stage[]).map((step,index)=><button key={step} className={`workflow-step ${stage===step?'active':''}`} aria-current={stage===step?'step':undefined} disabled={disabled||(step==='outline'&&!outline)||(step==='editor'&&!deck)} onClick={()=>setStage(step)}><span className="step-number">{String(index+1).padStart(2,'0')}</span><span>{['输入材料','确认大纲','编辑与导出'][index]}</span></button>)}</nav>
    <div className="workspace-tools">
      <div className="history-actions" aria-label="编辑历史" title="保留本次打开期间最近 50 步；刷新或打开其他文稿后重置。">
        <button className="text-button" aria-label="撤销" title="撤销（Ctrl / ⌘ Z）" disabled={disabled||!history.past.length} onClick={undo}><Icon name="undo" size={16}/>撤销</button>
        <button className="text-button" aria-label="重做" title="重做（Ctrl Y / ⌘ Shift Z）" disabled={disabled||!history.future.length} onClick={redo}><Icon name="redo" size={16}/>重做</button>
      </div>
      <div className="workspace-save"><p role="status" className={`save-status ${saveState}`}>{storageBlocked?'自动保存暂停':saveState==='saved'?`${platform?.mode==='demo'?'已保存到本机':'已保存到 Anna'}`:saveState==='saving'?'正在保存…':saveState==='invalid'?'当前草稿无法保存，请检查输入':saveState==='error'?'保存失败':'支持自动保存'}{saveState==='error'&&<button className="text-button" onClick={()=>setSaveRetry(x=>x+1)}>重试</button>}</p>{saveState==='error'&&<p className="save-detail">{saveError}</p>}</div>
    </div></>}
    <main>
      {platform?.mode==='demo'&&<div className="demo-banner"><Icon name="info" size={16}/><span>本地演示使用固定规则，不调用 AI。真实生成需在 Anna 中使用。</span></div>}
      {error&&<div className="alert error" role="alert"><Icon name="info"/><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={()=>setError('')}><Icon name="close" size={17}/></button></div>}
      {notice&&<div className="alert success" role="status"><Icon name="check"/><span>{notice}</span></div>}
      {storageBlocked&&<div className="alert warning"><Icon name="info"/><span>自动保存暂不可用，原有草稿不会被覆盖。可以继续编辑和导出备份。</span><button className="text-button" disabled={disabled} onClick={()=>hasWorkspaceContent(workspace)?setReloadOpen(true):setBootKey(k=>k+1)}>重新读取</button></div>}
      {!!busy&&<div className="busy-bar" role="status" aria-live="polite"><span className="spinner"/>{busy}<span>请勿重复提交</span></div>}

      {startupDraft&&<section className="startup-page">
        <div className="intro"><h1>开始制作演示文稿</h1><p>继续上次工作，或从新的材料开始。</p></div>
        <article className="resume-card">
          <span className="resume-label">上次草稿</span>
          <h2>{startupDraft.deck?.title||startupDraft.outline?.title||startupDraft.brief.title||'未命名演示'}</h2>
          <p>{({brief:'输入材料',outline:'确认大纲',editor:'编辑与导出'})[startupDraft.stage]}{startupDraft.deck?` · ${startupDraft.deck.slides.length} 页`:startupDraft.outline?` · ${startupDraft.outline.slides.length} 页大纲`:''}</p>
          <button className="button primary" disabled={disabled} onClick={()=>{setHistory(createHistory(startupDraft));setStartupDraft(null);setNotice('已恢复上次草稿。');}}>继续上次草稿<Icon name="arrow" size={17}/></button>
        </article>
        <div className="startup-actions"><button className="button secondary" disabled={disabled} onClick={()=>setResetOpen(true)}>新建演示</button><p>原稿会保留，直到你确认开始新稿或导入其他文稿。</p></div>
      </section>}

      {!startupDraft&&stage==='brief'&&<div className="brief-page">
        <section className="intro"><h1>新建演示文稿</h1><p>输入材料，确认大纲后生成 PPT。</p></section>
        <div className="brief-grid">
          <section className="material-card">
            <div className="section-top"><div><h2>项目材料</h2><p>粘贴正文，或导入文本文件。</p></div><button className="text-button" onClick={()=>materialRef.current?.click()} disabled={disabled}><Icon name="upload" size={16}/>导入 TXT / MD</button></div>
            <label className="sr-only" htmlFor="source">项目材料</label>
            <textarea id="source" className="source-input" value={brief.source} onChange={e=>setBrief({...brief,source:e.target.value})} maxLength={LIMITS.sourceMax} disabled={disabled} placeholder={'输入项目背景、进展、数据和结论。\n\n例如：\n咖啡店完成了两周午高峰外带流程调整。\n主要成果：……\n存在问题：……\n下一步计划：……\n\n至少 80 字。建议按段落整理，便于引用来源。'}/>
            <div className="material-footer"><button className="text-button" disabled={disabled} onClick={()=>{setBrief({...SAMPLE_BRIEF});setNotice('已填入示例材料；项目和数据均为虚构。');}}>使用示例材料</button><span>{brief.source.length.toLocaleString()} / {LIMITS.sourceMax.toLocaleString()} 字</span></div>
          </section>
          <section className="brief-settings">
            <div className="section-top"><h2>演示设置</h2></div>
            <label>演示主题<input value={brief.title} onChange={e=>setBrief({...brief,title:e.target.value})} maxLength={LIMITS.title} placeholder="例如：咖啡店午高峰外带复盘" disabled={disabled}/></label>
            <label>目标受众<input value={brief.audience} onChange={e=>setBrief({...brief,audience:e.target.value})} maxLength={LIMITS.audience} placeholder="例如：项目评审同事" disabled={disabled}/></label>
            <label>演示目的<textarea rows={2} value={brief.goal} onChange={e=>setBrief({...brief,goal:e.target.value})} maxLength={LIMITS.goal} placeholder="例如：复盘试点结果，确定下周行动" disabled={disabled}/></label>
            <fieldset className="page-count"><legend>页数</legend>{[6,8,10].map(count=><button type="button" key={count} aria-pressed={brief.slideCount===count} className={brief.slideCount===count?'selected':''} onClick={()=>setBrief({...brief,slideCount:count})} disabled={disabled}>{count} 页</button>)}</fieldset>
            <button className="button primary generate-button" onClick={onOutline} disabled={disabled}>{platform?.mode==='demo'?'生成演示大纲':'生成大纲'}<Icon name="arrow" size={18}/></button>
            <p className="cost-note">{platform?.mode==='demo'?'本地规则演示，不消耗 AI 额度。':'此操作调用 AI。确认大纲后再生成幻灯片。'}</p>
          </section>
        </div>
      </div>}

      {!startupDraft&&stage==='outline'&&outline&&<section className="outline-page"><div className="page-heading"><div><h1>确认大纲</h1><p>调整每页标题、内容重点和顺序。</p></div><span className="count-chip">{outline.slides.length} 页大纲</span></div>{!sameBrief(outlineBrief,brief)&&<div className="alert warning">材料或目标已修改，请返回第一步重新生成大纲。</div>}<div className="outline-title-card card"><label>文稿标题<input value={outline.title} onChange={e=>setOutline({...outline,title:e.target.value})} maxLength={LIMITS.title} disabled={disabled}/></label><label>文稿摘要<input value={outline.subtitle} onChange={e=>setOutline({...outline,subtitle:e.target.value})} maxLength={LIMITS.subtitle} disabled={disabled}/></label></div><div className="outline-list">{outline.slides.map((item,index)=><article key={item.id} className="outline-card card"><span className="outline-number">{String(index+1).padStart(2,'0')}</span><div className="outline-fields"><label><span className="sr-only">第{index+1}页标题</span><input aria-label={`第${index+1}页标题`} value={item.title} maxLength={LIMITS.title} disabled={disabled} onChange={e=>setOutline({...outline,slides:outline.slides.map((s,i)=>i===index?{...s,title:e.target.value}:s)})}/></label><label><span className="sr-only">第{index+1}页核心信息</span><textarea aria-label={`第${index+1}页核心信息`} value={item.keyMessage} rows={2} maxLength={LIMITS.keyMessage} disabled={disabled} onChange={e=>setOutline({...outline,slides:outline.slides.map((s,i)=>i===index?{...s,keyMessage:e.target.value}:s)})}/></label><div className="outline-source"><Icon name="link" size={13}/>{item.sourceIds.map(id=><span key={id}>{id}</span>)}<span>材料来源</span></div></div><div className="outline-controls"><select aria-label={`第${index+1}页版式`} value={item.layout} disabled={disabled} onChange={e=>setOutline({...outline,slides:outline.slides.map((s,i)=>i===index?{...s,layout:e.target.value as Layout}:s)})}>{Object.entries(LAYOUTS).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select><div><button className="icon-button" aria-label={`第${index+1}页上移`} disabled={disabled||index===0} onClick={()=>{const slides=[...outline.slides];[slides[index-1],slides[index]]=[slides[index],slides[index-1]];setOutline({...outline,slides});}}><Icon name="up" size={16}/></button><button className="icon-button" aria-label={`第${index+1}页下移`} disabled={disabled||index===outline.slides.length-1} onClick={()=>{const slides=[...outline.slides];[slides[index+1],slides[index]]=[slides[index],slides[index+1]];setOutline({...outline,slides});}}><Icon name="down" size={16}/></button></div></div></article>)}</div><div className="outline-actions"><button className="button secondary" disabled={disabled} onClick={()=>setStage('brief')}><Icon name="back" size={17}/>返回材料</button><span>生成后可继续编辑每页内容。</span><button className="button primary" disabled={disabled||!sameBrief(outlineBrief,brief)} onClick={onDeck}>{platform?.mode==='demo'?'生成演示幻灯片':'生成幻灯片'}<Icon name="arrow" size={18}/></button></div></section>}

      {!startupDraft&&stage==='editor'&&deck&&currentSlide&&<section className="editor-page"><div className="editor-top"><div><div className="document-title"><h1>{deck.title}</h1><span className="count-chip">{deck.slides.length} 页</span></div></div><div className="editor-top-actions"><button className="button secondary compact" disabled={disabled} onClick={exportJson}><Icon name="file" size={16}/><span>草稿备份</span></button><button className="button primary compact" disabled={disabled} onClick={exportDeck}><Icon name="download" size={18}/>导出 PPTX</button></div></div><div className="editor-workspace"><aside className="slides-rail" aria-label="幻灯片列表"><div className="rail-heading">页面<span>{String(selected+1).padStart(2,'0')} / {deck.slides.length}</span></div>{deck.slides.map((slide,index)=><button key={slide.id} className={`thumbnail ${selected===index?'selected':''}`} aria-current={selected===index?'true':undefined} onClick={()=>{setSelected(index);setRewriteInstruction('');}} disabled={disabled}><span className="thumb-number">{String(index+1).padStart(2,'0')}</span><div className="thumb-preview"><SlidePreview slide={slide} theme={deck.theme} index={index} total={deck.slides.length} images={imageResources.urls} compact/></div><span className="thumb-title">{slide.title||'未命名页面'}</span></button>)}</aside><div className="editor-main"><div className="page-actions" aria-label="页面操作"><button className="text-button" disabled={disabled||deck.slides.length>=LIMITS.maxEditedSlides} onClick={()=>operatePage('add')}><Icon name="plus" size={16}/>新增页</button><button className="text-button" disabled={disabled||deck.slides.length>=LIMITS.maxEditedSlides} onClick={()=>operatePage('copy')}><Icon name="copy" size={16}/>复制页</button><button className="text-button" disabled={disabled||deck.slides.length<=1} onClick={()=>operatePage('delete')}><Icon name="trash" size={16}/>删除页</button><span>{deck.slides.length} / {LIMITS.maxEditedSlides} 页</span></div><div className="canvas-toolbar"><div className="theme-picker" aria-label="演示配色"><span className="toolbar-label">配色</span>{(Object.keys(THEMES) as ThemeId[]).map(id=><button key={id} title={THEMES[id].name} aria-label={`配色：${THEMES[id].name}`} aria-pressed={deck.theme===id} className={`theme-swatch ${id} ${deck.theme===id?'selected':''}`} disabled={disabled} onClick={()=>updateDeck(current=>({...current,theme:id}))}><span/>{THEMES[id].name}</button>)}</div><div className="page-order"><button className="icon-button" aria-label="当前页上移" disabled={disabled||selected===0} onClick={()=>moveSlide(-1)}><Icon name="up" size={17}/></button><button className="icon-button" aria-label="当前页下移" disabled={disabled||selected===deck.slides.length-1} onClick={()=>moveSlide(1)}><Icon name="down" size={17}/></button></div></div><div className="slide-stage"><SlidePreview slide={currentSlide} theme={deck.theme} index={selected} total={deck.slides.length} images={imageResources.urls}/></div><div className="canvas-caption"><span>16:9 宽屏 · 文字与形状可编辑</span><button className="text-button" onClick={()=>setEditorTab('sources')}><Icon name="link" size={14}/>{currentSlide.sourceIds.length} 处材料引用</button></div>{currentIssues.length>0&&<div className="quality-hints"><Icon name="info" size={16}/><div>{currentIssues.map((issue,index)=><p key={index}>{issue}</p>)}</div></div>}<details className="notes-card"><summary><Icon name="file" size={16}/>演讲备注<span>随 PPTX 导出</span></summary><label className="sr-only" htmlFor="speaker-notes">演讲备注</label><textarea id="speaker-notes" value={currentSlide.speakerNotes} maxLength={LIMITS.speakerNotes} disabled={disabled} onChange={e=>editSlide({speakerNotes:e.target.value})} rows={4} placeholder="输入演讲备注"/></details></div><aside className="inspector"><div className="inspector-tabs"><button className={editorTab==='content'?'active':''} onClick={()=>setEditorTab('content')}>编辑内容</button><button className={editorTab==='sources'?'active':''} onClick={()=>setEditorTab('sources')}>材料出处</button></div>{editorTab==='content'?<div className="inspector-content"><label>页面版式<select value={currentSlide.layout} disabled={disabled} onChange={e=>editSlide({layout:e.target.value as Layout})}>{Object.entries(LAYOUTS).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></label><section className="typography-editor" aria-label="文字字号"><div className="typography-heading"><h3>文字字号 · pt</h3><button className="text-button" disabled={disabled||!currentSlide.typography} onClick={()=>editSlide({typography:undefined})}>恢复自动</button></div><div className="typography-fields">{([['titleSize','标题'],['subtitleSize','核心信息'],['bodySize','正文']] as const).map(([field,title])=><FontSizeField key={`${currentSlide.id}:${field}`} label={title} value={getSlideTypography(currentSlide)[field]} automatic={currentSlide.typography?.[field]===undefined} range={TYPOGRAPHY_RANGES[field]} disabled={disabled} onChange={value=>editSlide({typography:{...currentSlide.typography,[field]:value}})}/>)}</div><p className="typography-note">仅调整当前页，同步到 PPTX。自动项会随内容适配；超出空间时可减小字号或拆页。</p></section><section className="image-editor" aria-label="页面图片"><div className="image-editor-heading"><h3>页面图片</h3><div className="image-editor-actions"><button className="text-button" disabled={disabled} onClick={()=>{setError('');setSampleImagesOpen(true);}}>示例图片</button><button className="text-button" disabled={disabled} onClick={()=>imageRef.current?.click()}><Icon name="upload" size={15}/>{currentSlide.image?'替换图片':'上传图片'}</button></div></div>{currentSlide.image?<><p className="image-filename" title={currentSlide.image.asset.name}>{currentSlide.image.asset.name}</p><p className="image-meta">{currentSlide.image.asset.width} × {currentSlide.image.asset.height} · {Math.ceil(currentSlide.image.asset.sizeBytes/1024)} KB</p>{imageResources.errors[currentSlide.image.asset.id]&&<div className="image-error" role="alert"><p>{imageResources.errors[currentSlide.image.asset.id]}</p><button className="text-button" onClick={imageResources.retry} disabled={disabled}>重新读取图片</button></div>}{currentSlide.layout==='image'?<div className="image-options"><label>图片位置<select aria-label="图片位置" value={currentSlide.image.side} disabled={disabled} onChange={e=>editSlide({image:{...currentSlide.image!,side:e.target.value as 'left'|'right'}})}><option value="left">图片在左</option><option value="right">图片在右</option></select></label><label>显示方式<select aria-label="显示方式" value={currentSlide.image.fit} disabled={disabled} onChange={e=>editSlide({image:{...currentSlide.image!,fit:e.target.value as 'contain'|'cover'}})}><option value="contain">完整显示</option><option value="cover">铺满裁剪</option></select></label></div>:<button className="text-button" disabled={disabled} onClick={()=>editSlide({layout:'image'})}>切换到图文版式以显示图片</button>}<button className="text-button" disabled={disabled} onClick={()=>editSlide({image:undefined})}>移除图片</button></>:<p>支持 PNG / JPG / WebP，最大 10 MB。上传后自动使用图文版式。</p>}{currentSlide.layout==='image'&&<p>建议使用 2–3 条简短要点；截图和图表适合完整显示。</p>}</section><label>标题<input value={currentSlide.title} maxLength={LIMITS.title} disabled={disabled} onChange={e=>editSlide({title:e.target.value})}/></label><label>核心信息<textarea value={currentSlide.subtitle} maxLength={LIMITS.subtitle} disabled={disabled} onChange={e=>editSlide({subtitle:e.target.value})} rows={2}/></label><div className="bullet-editor"><label>内容要点<span>{currentSlide.body.length} / {LIMITS.bodyItems}</span></label>{currentSlide.body.map((item,index)=><div className="bullet-input" key={index}><span>{index+1}</span><textarea aria-label={`第${index+1}条要点`} rows={2} value={item} disabled={disabled} maxLength={LIMITS.bodyItem} onChange={e=>editSlide({body:currentSlide.body.map((v,i)=>i===index?e.target.value:v)})}/><button className="remove-bullet" aria-label={`移除第${index+1}条要点`} disabled={disabled} onClick={()=>editSlide({body:currentSlide.body.filter((_,i)=>i!==index)})}><Icon name="close" size={13}/></button></div>)}<button className="add-bullet" disabled={disabled||currentSlide.body.length>=LIMITS.bodyItems} onClick={()=>editSlide({body:[...currentSlide.body,'']})}><Icon name="plus" size={14}/>添加要点</button></div><div className="rewrite-card"><h3>AI 改写</h3><textarea data-native-undo rows={2} value={rewriteInstruction} maxLength={200} onChange={e=>setRewriteInstruction(e.target.value)} disabled={disabled||platform?.mode==='demo'} placeholder={platform?.mode==='demo'?'在 Anna 中可用 AI 单页改写':'例如：更简洁，先讲结论，突出下一步行动。'}/><button className="button secondary" disabled={disabled||!rewriteInstruction.trim()||!currentSlide.sourceIds.length||platform?.mode==='demo'} onClick={onRewrite}>AI 改写当前页<Icon name="arrow" size={15}/></button><p>{currentSlide.sourceIds.length?'仅使用当前页及关联材料。':'先在“材料出处”中关联材料，再使用 AI 改写。'}</p></div></div>:<div className="source-panel"><p>勾选本页的材料依据，AI 改写仅使用选中材料。来源未作外部核验。</p>{deck.sourceBlocks.map(block=><article className="source-block" key={block.id}><label className="source-choice"><input type="checkbox" checked={currentSlide.sourceIds.includes(block.id)} disabled={disabled} onChange={e=>editSlide({sourceIds:e.target.checked?[...currentSlide.sourceIds,block.id]:currentSlide.sourceIds.filter(id=>id!==block.id)})}/>{block.id} · 关联本页</label><p>{block.text}</p></article>)}</div>}</aside></div></section>}
    </main>
    <footer className="app-footer"><span>汇页PPT</span><span>支持导出可编辑 PPTX</span></footer>

    {usageOpen&&<Modal title="AI 用量记录" onClose={()=>setUsageOpen(false)}><p className="modal-intro">本工作稿的调用记录。CU 以 Anna 返回值为准，未返回时显示“未提供”。</p><div className="usage-summary"><div><strong>{realCalls}</strong><span>真实 AI 调用</span></div><div><strong>{knownCu?totalCu.toFixed(2):'—'}</strong><span>已报告 CU</span></div></div><div className="usage-list">{usage.length?usage.slice().reverse().map(record=><div className="usage-row" key={record.id}><div><strong>{labelForOperation[record.operation]}</strong><span>{record.simulated?'本地模拟':record.model||'Anna 默认模型'} · {new Date(record.at).toLocaleTimeString('zh-CN')}</span></div><span>{record.simulated?'不消耗额度':record.quotaConsumed!=null?`${record.quotaConsumed.toFixed(2)} CU`:'CU 未提供'}</span></div>):<p>暂无调用记录。</p>}</div></Modal>}
    {sampleImagesOpen&&<Modal title="添加示例图片" onClose={()=>{if(!busyRef.current)setSampleImagesOpen(false);}}><p>选择一张图片加入当前页，正文保持不变。照片仅作场景示意，图表数据为虚构。</p><div className="sample-image-grid">{SAMPLE_IMAGES.map(item=><button key={item.file} className="sample-image-option" disabled={disabled} onClick={()=>addSampleImage(item)}><img src={`${import.meta.env.BASE_URL}examples/${item.file}`} alt={item.name}/><span>{item.name}</span></button>)}</div>{busy&&<p role="status">{busy}</p>}{error&&<p className="image-error" role="alert">{error}</p>}</Modal>}
    {pendingImport&&<Modal title={pendingImport.sample?"打开完整示例？":"打开这份草稿？"} onClose={()=>{if(!busyRef.current)setPendingImport(null);}}><p>将打开“{pendingImport.deck.title}”，共 {pendingImport.deck.slides.length} 页。当前工作稿会被替换，建议先下载备份。</p>{busy&&<p role="status">{busy}</p>}{error&&<p className="image-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={disabled} onClick={()=>setPendingImport(null)}>取消</button><button className="button primary" disabled={disabled} onClick={acceptImport}>导入并继续</button></div></Modal>}
    {reloadOpen&&<Modal title="重新读取已保存的草稿？" onClose={()=>setReloadOpen(false)}><p>这会替换读取失败后尚未保存的编辑。请先备份当前成稿，或复制需要保留的材料。</p><div className="modal-actions"><button className="button secondary" onClick={()=>setReloadOpen(false)}>保留当前编辑</button><button className="button primary" onClick={()=>{setReloadOpen(false);setBootKey(k=>k+1);}}>确认重新读取</button></div></Modal>}
    {resetOpen&&<Modal title="开始新的演示？" onClose={()=>setResetOpen(false)}><p>新稿会立即替换自动保存的当前工作稿，并清空本次撤销记录。需要保留成稿时，请先下载草稿备份。</p><div className="modal-actions"><button className="button secondary" onClick={()=>setResetOpen(false)}>继续当前稿</button><button className="button primary" onClick={()=>{setHistory(createHistory(emptyWorkspace()));setStartupDraft(null);setRewriteInstruction('');setError('');setNotice('');setResetOpen(false);}}>开始新稿</button></div></Modal>}
  </div>;
}

function safeFilename(value:string){return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,70)||'汇页演示文稿';}

function FontSizeField({label,value,automatic,range,disabled,onChange}:{label:string;value:number;automatic:boolean;range:{min:number;max:number;step:number};disabled:boolean;onChange:(value:number)=>void}){
  const [input,setInput]=useState(String(value));
  useEffect(()=>{setInput(String(value));},[value]);
  const valid=(text:string)=>text.trim()!==''&&Number.isInteger(Number(text))&&Number(text)>=range.min&&Number(text)<=range.max;
  return <label><span className="font-size-name">{label}</span><input aria-label={`${label}字号`} type="number" inputMode="numeric" min={range.min} max={range.max} step={range.step} value={input} disabled={disabled} onChange={event=>{const next=event.target.value;setInput(next);if(valid(next))onChange(Number(next));}} onBlur={()=>{if(!valid(input))setInput(String(value));}}/><span className="font-size-mode">{automatic?'自动':'手动'}</span></label>;
}

function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const node=dialog.current;if(node&&!node.open)node.showModal();return()=>{node?.close();};},[]);
  return <dialog className="modal" ref={dialog} onCancel={event=>{event.preventDefault();onClose();}} aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭对话框"><Icon name="close"/></button></div>{children}</dialog>;
}
