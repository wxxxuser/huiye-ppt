import { useEffect, useMemo, useState } from 'react';
import type { Deck, ImageAsset, Platform } from './types';

class ImageCache {
  private blobs=new Map<string,Promise<Blob>>();
  private urls=new Map<string,string>();
  private disposed=false;
  private wanted=new Set<string>();
  constructor(private platform:Platform|null){}
  activate(){this.disposed=false;}
  retain(ids:string[]){
    this.wanted=new Set(ids);
    for(const [id,url] of this.urls)if(!this.wanted.has(id)){URL.revokeObjectURL(url);this.urls.delete(id);}
    for(const id of this.blobs.keys())if(!this.wanted.has(id))this.blobs.delete(id);
  }
  read(asset:ImageAsset):Promise<Blob>{
    const existing=this.blobs.get(asset.id);if(existing)return existing;
    if(!this.platform)return Promise.reject(new Error('图片存储尚未连接。'));
    const pending=this.platform.loadImage(asset).catch(error=>{this.blobs.delete(asset.id);throw error;});
    this.blobs.set(asset.id,pending);return pending;
  }
  async url(asset:ImageAsset){
    const blob=await this.read(asset);
    if(this.disposed||!this.wanted.has(asset.id))throw new Error('图片视图已关闭。');
    if(!this.urls.has(asset.id))this.urls.set(asset.id,URL.createObjectURL(blob));
    return this.urls.get(asset.id)!;
  }
  dispose(){this.disposed=true;this.wanted.clear();for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();this.blobs.clear();}
}

/** URLs are temporary view resources. Only immutable asset metadata is persisted. */
export function useSlideImages(deck:Deck|null,platform:Platform|null){
  const cache=useMemo(()=>new ImageCache(platform),[platform]);
  const [urls,setUrls]=useState<Record<string,string>>({});
  const [errors,setErrors]=useState<Record<string,string>>({});
  const [retryKey,setRetryKey]=useState(0);
  const assetsJson=JSON.stringify([...new Map((deck?.slides??[]).flatMap(slide=>slide.image?[[slide.image.asset.id,slide.image.asset] as const]:[])).values()]);
  useEffect(()=>{cache.activate();return()=>cache.dispose();},[cache]);
  useEffect(()=>{
    let active=true;const assets=JSON.parse(assetsJson) as ImageAsset[];
    cache.retain(assets.map(asset=>asset.id));
    setErrors({});setUrls(current=>Object.fromEntries(assets.filter(a=>current[a.id]).map(a=>[a.id,current[a.id]])));
    if(!platform)return;
    for(const asset of assets)void cache.url(asset).then(url=>{if(active)setUrls(current=>({...current,[asset.id]:url}));}).catch(error=>{if(active)setErrors(current=>({...current,[asset.id]:error instanceof Error?error.message:'图片读取失败。'}));});
    return()=>{active=false;};
  },[assetsJson,cache,platform,retryKey]);
  return {urls,errors,read:(asset:ImageAsset)=>cache.read(asset),retry:()=>setRetryKey(key=>key+1)};
}
