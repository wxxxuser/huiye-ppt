import JSZip from 'jszip';
import { validateStoredDeck } from './domain';
import type { Deck, ImageAsset } from './types';
import { deckAssets } from './image-assets';
export { deckAssets } from './image-assets';

const MAX_BACKUP_BYTES=20*1024*1024;
const MAX_JSON_BYTES=512_000;
export interface ImportedDraft { deck:Deck; images:Map<string,Blob> }

export async function buildBackup(deck:Deck,read:(asset:ImageAsset)=>Promise<Blob>):Promise<Uint8Array>{
  if(!validateStoredDeck(deck))throw new Error('草稿格式不正确，无法备份。');
  const zip=new JSZip();const json=JSON.stringify({format:'huiye-backup',version:1,deck});
  const jsonSize=new TextEncoder().encode(json).length;
  if(jsonSize>MAX_JSON_BYTES)throw new Error('草稿文字超过备份大小限制。');
  zip.file('deck.json',json);let bytes=jsonSize;
  for(const asset of deckAssets(deck)){
    const blob=await read(asset);bytes+=blob.size;
    if(bytes>MAX_BACKUP_BYTES-65536)throw new Error('图片备份超过 20 MB，请减少图片后重试。');
    zip.file(asset.path,await blob.arrayBuffer(),{compression:'STORE'});
  }
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

// Check central-directory sizes before decompression: an uploaded ZIP must not
// allocate unlimited memory or smuggle files through path normalization.
function checkArchive(bytes:Uint8Array){
  if(bytes.length>MAX_BACKUP_BYTES||bytes.length<22)throw new Error('备份文件为空或超过 20 MB。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--){if(view.getUint32(at,true)===0x06054b50&&at+22+view.getUint16(at+20,true)===bytes.length){end=at;break;}}
  if(end<0)throw new Error('备份 ZIP 不完整。');
  const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count>64||start+size!==end)throw new Error('不支持此备份 ZIP 格式。');
  let at=start,total=0;const names=new Set<string>();
  for(let i=0;i<count;i++){
    if(at+46>end||view.getUint32(at,true)!==0x02014b50)throw new Error('备份目录损坏。');
    const length=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true);
    if(at+46+length+extra+comment>end)throw new Error('备份目录损坏。');
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(at+46,at+46+length));
    const raw=view.getUint32(at+24,true);total+=raw;
    const valid=name==='deck.json'||name==='assets/'||/^assets\/img-[a-f0-9-]{36}\.(png|jpg)$/.test(name);
    if(!valid||names.has(name)||raw>(name==='deck.json'?MAX_JSON_BYTES:1024*1024)||total>MAX_BACKUP_BYTES)throw new Error('备份含未知文件、重复路径或过大的图片。');
    names.add(name);at+=46+length+extra+comment;
  }
  if(at!==end||!names.has('deck.json'))throw new Error('备份缺少文稿。');
}

export async function readBackup(bytes:Uint8Array):Promise<ImportedDraft>{
  checkArchive(bytes);
  const zip=await JSZip.loadAsync(bytes,{checkCRC32:true});
  const document=JSON.parse(await zip.file('deck.json')!.async('string'));
  if(document.format!=='huiye-backup'||document.version!==1)throw new Error('请选择汇页导出的 .huiye.zip 备份。');
  const deck=validateStoredDeck(document.deck);if(!deck)throw new Error('备份中的文稿格式无效。');
  const images=new Map<string,Blob>();
  for(const asset of deckAssets(deck)){
    const entry=zip.file(asset.path);if(!entry)throw new Error(`备份中缺少图片：${asset.name}`);
    const data=await entry.async('uint8array');if(data.length!==asset.sizeBytes)throw new Error(`图片文件损坏：${asset.name}`);
    images.set(asset.id,new Blob([new Uint8Array(data)],{type:asset.mimeType}));
  }
  return {deck,images};
}
