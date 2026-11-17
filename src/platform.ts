import type { CompletionRequest, CompletionResponse, Deck, ImageAsset, Platform, PreparedImage, WorkspaceDraft } from './types';
import { workspaceSnapshot } from './workspace';
import { inspectImageBlob, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, safeImageName } from './images';

const SDK_URL = '/static/anna-apps/_sdk/latest/index.js';
const DRAFT_KEY = 'drafts/current-v1';
const DEMO_STORAGE_KEY = 'huiye-ppt:demo:draft:v1';
const CONNECT_TIMEOUT_MS = 15_000;
const STORAGE_TIMEOUT_MS = 20_000;
const COMPLETION_TIMEOUT_MS = 180_000;
const MAX_DRAFT_BYTES = 200 * 1024;
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

interface HostOptions { timeoutMs: number }
interface AnnaRuntime {
  llm: { complete(request: CompletionRequest, options?: HostOptions): Promise<unknown> };
  storage: {
    get(args: { key: string; scope: 'app' }, options?: HostOptions): Promise<unknown>;
    set(args: { key: string; value: unknown; scope: 'app'; if_match?: string }, options?: HostOptions): Promise<unknown>;
  };
  files: {
    list(args: { prefix: string; limit: number }, options?: HostOptions): Promise<unknown>;
    upload_init(args: { path: string; content_type: string; size: number; ttl_seconds: number; if_match?: string }, options?: HostOptions): Promise<unknown>;
    upload_finalize(args: { path: string; size_bytes: number; etag?: string }, options?: HostOptions): Promise<unknown>;
    download(args: { path: string; filename: string }, options?: HostOptions): Promise<unknown>;
    download_url(args: { path: string; ttl_seconds: number }, options?: HostOptions): Promise<unknown>;
  };
  window: { set_title(args: { title: string }, options?: HostOptions): Promise<unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorCode(error: unknown): string {
  if (!isRecord(error)) return '';
  if (error.code === -32601) return 'method_not_found';
  const details = isRecord(error.details) ? error.details : {};
  const data = isRecord(error.data) ? error.data : isRecord(details.data) ? details.data : {};
  for (const candidate of [data.errorName, data.errorCode, details.errorName, details.errorCode, error.code]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)) return candidate;
  }
  return '';
}

/** Do not expose launch tokens, request bodies, or provider payloads in UI errors. */
function operationError(operation: string, error: unknown): Error {
  const code = errorCode(error);
  if (code === 'APP_QUOTA_EXCEEDED' || (operation === 'AI 生成' && code === 'quota_exceeded')) {
    return new Error('Anna 额度不足，或余额无法覆盖本次输出上限。请减少页数或检查平台额度后再试。');
  }
  if (operation === 'AI 生成' && ['llm_disabled', 'not_implemented', 'method_not_found', '-32601'].includes(code)) {
    return new Error('当前环境未提供 Anna AI。请从 Anna 平台打开汇页 PPT，或连接真实账号后再生成；不会用示例内容替代 AI 结果。');
  }
  if (code === 'precondition_failed') {
    return new Error(operation.includes('草稿')
      ? '草稿已在另一个窗口更新，本次保存没有覆盖它。请先导出当前内容，再重新打开 App。'
      : '导出文件已发生变化，本次操作没有覆盖它。请等待其他导出完成后重试。');
  }
  if (code === 'quota_exceeded' || code === 'value_too_large' || code === 'state_too_large') {
    return new Error('Anna 存储空间不足或内容过大，请缩短原始材料后再试。');
  }
  if (code === 'APP_NOT_GRANTED' || code === 'permission_denied' || code === 'not_granted') {
    return new Error('Anna 未允许本次操作。请确认汇页 PPT 已安装、已启用，且账号可使用相应服务。');
  }
  if (error instanceof Error && /timed?\s*out|timeout|超时/i.test(error.message)) {
    return new Error(operation === 'AI 生成'
      ? 'AI 请求等待超时。平台端可能仍在处理并计费；本 App 没有自动重试，请先查看 Anna 用量后再决定是否重试。'
      : `${operation}超时。请检查 Anna 连接后再试；本次没有切换到本地演示。`);
  }
  if (code === 'APP_PROVIDER_ERROR') return new Error('Anna 模型服务暂时不可用，请稍后手动重试。');
  // Unknown error codes can themselves contain request data. Do not echo them.
  return new Error(`${operation}失败，请检查 Anna 连接后再试。`);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function draftSnapshot(draft: WorkspaceDraft | Deck): WorkspaceDraft {
  const snapshot = workspaceSnapshot(draft);
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_BYTES) {
    throw new Error('草稿超过 200 KB，请缩短原始材料或备注后再保存。当前内容仍可导出。');
  }
  return snapshot;
}

function exportFile(bytes: Uint8Array, filename: string, mimeType: string) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EXPORT_BYTES) {
    throw new Error('导出文件为空或超过 20 MB，请减少内容后重试。');
  }
  const safeName = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 160) || 'huiye-ppt.pptx';
  const extension = /\.([a-z0-9]{1,12})$/i.exec(safeName)?.[1].toLowerCase() ?? 'bin';
  return {
    name: safeName,
    path: `exports/current.${extension}`,
    // A copied ArrayBuffer also works with strict TS DOM BlobPart typings.
    blob: new Blob([new Uint8Array(bytes)], { type: mimeType }),
  };
}

function imageAssetShape(asset: ImageAsset): void {
  if (!/^img-[a-f0-9-]{36}$/.test(asset.id) || asset.path !== `assets/${asset.id}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`
    || !['image/png', 'image/jpeg'].includes(asset.mimeType)
    || !Number.isInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > MAX_IMAGE_BYTES
    || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1
    || asset.width > MAX_IMAGE_EDGE || asset.height > MAX_IMAGE_EDGE) throw new Error('图片引用格式不正确。');
}

async function prepareAsset(image: PreparedImage): Promise<{ asset: ImageAsset; blob: Blob }> {
  // Copy metadata before any await; Blob bytes are already immutable.
  const { blob, width, height, name } = image;
  if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size === 0 || blob.size > MAX_IMAGE_BYTES) {
    throw new Error('图片须为压缩后的 PNG/JPEG，且不超过 1 MB。');
  }
  const id = `img-${crypto.randomUUID()}`;
  const mimeType = blob.type as ImageAsset['mimeType'];
  const asset: ImageAsset = { id, path: `assets/${id}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
    name: safeImageName(name, mimeType), mimeType, width, height, sizeBytes: blob.size };
  imageAssetShape(asset);
  await verifyImageBlob(blob, asset);
  return { asset, blob };
}

async function verifyImageBlob(blob: Blob, asset: ImageAsset): Promise<void> {
  if (blob.size !== asset.sizeBytes || blob.size > MAX_IMAGE_BYTES) throw new Error('图片文件大小与保存记录不一致。');
  const info = await inspectImageBlob(blob);
  if (info.mimeType !== asset.mimeType || info.width !== asset.width || info.height !== asset.height) {
    throw new Error('图片内容与保存记录不一致，请重新上传。');
  }
}

function openImageDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('浏览器未开放本地图片存储，请检查存储权限。')); return; }
    let blocked = false;
    const request = indexedDB.open('huiye-ppt-assets', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('images')) request.result.createObjectStore('images'); };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(new Error('无法打开本地图片存储，请检查浏览器存储权限。'));
    request.onblocked = () => { blocked = true; reject(new Error('本地图片存储被其他窗口占用，请关闭其他页面后重试。')); };
  });
}

async function localImage(path: string, blob?: Blob): Promise<Blob> {
  const database = await openImageDatabase();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const transaction = database.transaction('images', blob ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('images');
      const request = blob ? store.put(blob, path) : store.get(path);
      let result: Blob | undefined = blob;
      request.onsuccess = () => { if (!blob) result = request.result instanceof Blob ? request.result : undefined; };
      transaction.oncomplete = () => result ? resolve(result) : reject(new Error('本地图片已不存在，请重新上传或从含图片的备份恢复。'));
      transaction.onerror = () => reject(new Error('本地图片保存或读取失败，请检查浏览器存储空间。'));
      transaction.onabort = () => reject(new Error('本地图片操作未完成，当前页面内容未替换。'));
    });
  } finally { database.close(); }
}

export function createDemoPlatform(): Platform {
  return {
    mode: 'demo',
    label: '本地演示 · 未连接 Anna AI',
    async complete() {
      throw new Error('本地演示没有提供 AI 服务。请明确选择“加载示例”，或从 Anna 平台打开汇页 PPT 后生成。');
    },
    async loadDraft() {
      try {
        const value = window.localStorage.getItem(DEMO_STORAGE_KEY);
        return value === null ? null : JSON.parse(value) as unknown;
      } catch {
        throw new Error('无法读取本地演示草稿，请检查浏览器存储权限。原草稿没有被覆盖。');
      }
    },
    async saveDraft(deck) {
      const value = draftSnapshot(deck);
      try { window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(value)); }
      catch { throw new Error('无法保存本地演示草稿，请检查浏览器存储空间或先导出。'); }
    },
    async setTitle(title) { document.title = title.trim().slice(0, 120) || '汇页 PPT'; },
    async saveImage(image) {
      const { asset, blob } = await prepareAsset(image);
      await localImage(asset.path, blob);
      return asset;
    },
    async loadImage(asset) {
      imageAssetShape(asset);
      const blob = await localImage(asset.path);
      await verifyImageBlob(blob, asset);
      return blob;
    },
    async saveFile(bytes, filename, mimeType) {
      const file = exportFile(bytes, filename, mimeType);
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

export function createHostPlatform(anna: AnnaRuntime): Platform {
  let currentEtag: string | undefined;
  let loaded = false;
  let saveQueue: Promise<void> = Promise.resolve();
  let exportQueue: Promise<void> = Promise.resolve();

  async function loadDraft(): Promise<unknown> {
    let response: unknown;
    try {
      response = await withTimeout(
        anna.storage.get({ key: DRAFT_KEY, scope: 'app' }, { timeoutMs: STORAGE_TIMEOUT_MS }),
        STORAGE_TIMEOUT_MS + 1_000,
        '读取草稿超时',
      );
    } catch (error) { throw operationError('读取草稿', error); }
    if (!isRecord(response) || !('value' in response)) {
      throw new Error('Anna 返回的草稿格式无法识别，已暂停保存以保护已有内容。');
    }
    // APS uses exists, not the truthiness of value (stored null is valid).
    // Older local harnesses omit exists but still return { key, value }.
    currentEtag = typeof response.etag === 'string' ? response.etag : undefined;
    loaded = true;
    return response.exists === false ? null : response.value;
  }

  return {
    mode: 'anna',
    label: 'Anna AI 已连接',
    async complete(request): Promise<CompletionResponse> {
      if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 8192) {
        throw new Error('本次 AI 输出上限必须在 1–8192 tokens 之间。');
      }
      if (!request.messages.length || request.messages.some(message =>
        !['user', 'assistant', 'system'].includes(message.role)
        || message.content.type !== 'text' || typeof message.content.text !== 'string')) {
        throw new Error('AI 请求内容无效，请重新填写材料。');
      }
      let response: unknown;
      try {
        // MCP-shaped text blocks, camelCase maxTokens, and explicit thinking:false.
        // One user action = one request. No retry, model probing, or fallback call.
        response = await withTimeout(
          anna.llm.complete({ messages: request.messages, maxTokens: request.maxTokens, thinking: false },
            { timeoutMs: COMPLETION_TIMEOUT_MS }),
          COMPLETION_TIMEOUT_MS + 1_000,
          'AI 请求等待超时',
        );
      } catch (error) { throw operationError('AI 生成', error); }
      if (!isRecord(response) || !isRecord(response.content)
        || response.content.type !== 'text' || typeof response.content.text !== 'string') {
        throw new Error('Anna 未返回可读取的文本结果。本次没有自动重试，请先检查平台用量。');
      }
      const usage = isRecord(response.usage) ? response.usage : {};
      const meta = isRecord(response._meta) ? response._meta : {};
      return {
        content: { type: 'text', text: response.content.text },
        model: typeof response.model === 'string' ? response.model : undefined,
        stopReason: typeof response.stopReason === 'string' ? response.stopReason : undefined,
        usage: {
          inputTokens: finiteNumber(usage.inputTokens), outputTokens: finiteNumber(usage.outputTokens),
          totalTokens: finiteNumber(usage.totalTokens),
        },
        // Missing quotaConsumed is unknown, not zero CU.
        _meta: { quotaConsumed: finiteNumber(meta.quotaConsumed) },
      };
    },
    loadDraft,
    saveDraft(deck) {
      let value: unknown;
      try { value = draftSnapshot(deck); }
      catch (error) { return Promise.reject(error); }
      const job = saveQueue.then(async () => {
        if (!loaded) await loadDraft();
        try {
          const response = await withTimeout(
            anna.storage.set({ key: DRAFT_KEY, value, scope: 'app', ...(currentEtag ? { if_match: currentEtag } : {}) },
              { timeoutMs: STORAGE_TIMEOUT_MS }),
            STORAGE_TIMEOUT_MS + 1_000,
            '保存草稿超时',
          );
          if (isRecord(response) && typeof response.etag === 'string') currentEtag = response.etag;
        } catch (error) { throw operationError('保存草稿', error); }
      });
      // Serialize writes so a slower earlier autosave cannot replace a later edit.
      saveQueue = job.catch(() => {});
      return job;
    },
    async setTitle(title) {
      try {
        await withTimeout(anna.window.set_title({ title: title.trim().slice(0, 120) || '汇页 PPT' }, { timeoutMs: 10_000 }),
          11_000, '更新窗口标题超时');
      } catch (error) { throw operationError('更新窗口标题', error); }
    },
    async saveImage(image) {
      const { asset, blob } = await prepareAsset(image);
      let stage = '申请图片上传';
      try {
        const upload = await withTimeout(anna.files.upload_init({ path: asset.path, content_type: asset.mimeType,
          size: blob.size, ttl_seconds: 600 }, { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1000, `${stage}超时`);
        if (!isRecord(upload) || typeof upload.put_url !== 'string' || !isRecord(upload.headers)) throw new Error('Invalid upload response');
        const destination = new URL(upload.put_url);
        if (destination.protocol !== 'https:') throw new Error('Upload requires HTTPS');
        const headers = new Headers();
        for (const [key, value] of Object.entries(upload.headers)) {
          if (typeof value !== 'string') throw new Error('Invalid signed header');
          headers.set(key, value);
        }
        if (!headers.has('Content-Type')) headers.set('Content-Type', asset.mimeType);
        stage = '上传图片';
        const response = await fetch(destination.href, { method: 'PUT', headers, body: blob, credentials: 'omit',
          redirect: 'error', signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error('Image upload failed');
        stage = '确认图片上传';
        const etag = response.headers.get('ETag');
        const finalized = await withTimeout(anna.files.upload_finalize({ path: asset.path, size_bytes: blob.size,
          ...(etag ? { etag } : {}) }, { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1000, `${stage}超时`);
        if (!isRecord(finalized) || finalized.path !== asset.path || typeof finalized.etag !== 'string'
          || (finalized.size_bytes !== undefined && finalized.size_bytes !== blob.size)) throw new Error('Invalid upload finalization');
        return asset;
      } catch (error) { throw operationError(stage, error); }
    },
    async loadImage(asset) {
      imageAssetShape(asset);
      try {
        // Always re-sign: signed URLs must never be saved in the document.
        const signed = await withTimeout(anna.files.download_url({ path: asset.path, ttl_seconds: 600 },
          { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1000, '读取图片超时');
        if (!isRecord(signed) || typeof signed.get_url !== 'string'
          || (signed.size_bytes !== undefined && signed.size_bytes !== asset.sizeBytes)
          || (signed.content_type !== undefined && signed.content_type !== asset.mimeType)) throw new Error('Invalid image response');
        const source = new URL(signed.get_url);
        if (source.protocol !== 'https:') throw new Error('Image download requires HTTPS');
        const response = await fetch(source.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60_000) });
        if (!response.ok || !response.body) throw new Error('Image download failed');
        const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
        if (contentType && contentType !== asset.mimeType) throw new Error('Image MIME mismatch');
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > asset.sizeBytes || size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('Image size exceeded'); }
            chunks.push(new Uint8Array(part.value));
          }
        } finally { reader.releaseLock(); }
        const blob = new Blob(chunks, { type: asset.mimeType });
        await verifyImageBlob(blob, asset);
        return blob;
      } catch (error) { throw operationError('读取图片', error); }
    },
    saveFile(bytes, filename, mimeType) {
      let file: ReturnType<typeof exportFile>;
      try { file = exportFile(bytes, filename, mimeType); }
      catch (error) { return Promise.reject(error); }
      const job = exportQueue.then(async () => {
        let stage = '读取导出文件信息';
        try {
          const entries = await withTimeout(anna.files.list({ prefix: file.path, limit: 100 },
            { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1_000, `${stage}超时`);
          if (!isRecord(entries) || !Array.isArray(entries.items)) throw new Error('Invalid file list response');
          const prior = entries.items.find((item: unknown) => isRecord(item) && item.path === file.path) as Record<string, unknown> | undefined;
          const etag = typeof prior?.etag === 'string' ? prior.etag : undefined;
          stage = '申请导出上传';
          const upload = await withTimeout(anna.files.upload_init({
            path: file.path, content_type: mimeType, size: file.blob.size, ttl_seconds: 600,
            ...(etag ? { if_match: etag } : {}),
          }, { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1_000, `${stage}超时`);
          if (!isRecord(upload) || typeof upload.put_url !== 'string' || !isRecord(upload.headers)) {
            throw new Error('Invalid upload initialization response');
          }
          const destination = new URL(upload.put_url);
          if (destination.protocol !== 'https:') throw new Error('Upload requires HTTPS');
          const headers = new Headers();
          for (const [key, value] of Object.entries(upload.headers)) {
            if (typeof value !== 'string') throw new Error('Invalid upload header');
            headers.set(key, value);
          }
          // Keep all signed headers exactly as supplied by the host.
          if (!headers.has('Content-Type')) headers.set('Content-Type', mimeType);
          stage = '上传导出文件';
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), 120_000);
          let uploaded: Response;
          try {
            uploaded = await fetch(destination.href, {
              method: 'PUT', headers, body: file.blob, credentials: 'omit',
              signal: controller.signal, redirect: 'error',
            });
          } finally { clearTimeout(abortTimer); }
          if (!uploaded.ok) throw new Error(`Upload HTTP ${uploaded.status}`);
          const objectEtag = uploaded.headers.get('ETag');
          stage = '确认导出文件';
          const finalized = await withTimeout(anna.files.upload_finalize({
            path: file.path, size_bytes: file.blob.size, ...(objectEtag ? { etag: objectEtag } : {}),
          }, { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1_000, `${stage}超时`);
          if (!isRecord(finalized) || finalized.path !== file.path || typeof finalized.etag !== 'string') {
            throw new Error('Invalid upload finalization response');
          }
          stage = '启动文件下载';
          // files is a dynamic SDK namespace proxy; download does not need to
          // appear in its comment/example method list. The HOST opens the save.
          const result = await withTimeout(anna.files.download({ path: file.path, filename: file.name },
            { timeoutMs: STORAGE_TIMEOUT_MS }), STORAGE_TIMEOUT_MS + 1_000, `${stage}超时`);
          if (!isRecord(result) || result.ok !== true) throw new Error('Host did not confirm download');
        } catch (error) {
          if (stage === '上传导出文件' && !errorCode(error)) {
            throw new Error('导出文件未能上传到 Anna，请检查网络或联系 App 开发者。下载尚未开始，当前文稿仍保留在编辑器中。');
          }
          throw operationError(stage, error);
        }
      });
      exportQueue = job.catch(() => {});
      return job;
    },
  };
}

let connection: Promise<Platform> | undefined;

/** Shared across React StrictMode mounts; a failed host connection needs reload. */
export function connectPlatform(): Promise<Platform> {
  connection ??= connectOnce();
  return connection;
}

async function connectOnce(): Promise<Platform> {
  const params = new URLSearchParams(window.location.search);
  const hasAnnaLaunch = ['wid', 't', 'window_uuid', 'app_session_token'].some(key => params.has(key));
  if (window === window.parent && !hasAnnaLaunch) return createDemoPlatform();
  if (window === window.parent) throw new Error('检测到 Anna 启动参数，但当前页面不在 Anna 容器内。请回到平台重新打开汇页 PPT。');
  if (!params.get('wid') || !params.get('t')) {
    throw new Error('Anna 启动参数缺失。请从 Anna 平台或 anna-app 本地测试容器打开汇页 PPT。');
  }
  try {
    const anna = await withTimeout((async () => {
      const sdk = await import(/* @vite-ignore */ SDK_URL) as { AnnaAppRuntime?: { connect(): Promise<AnnaRuntime> } };
      if (typeof sdk.AnnaAppRuntime?.connect !== 'function') throw new Error('Anna SDK 不可用');
      return sdk.AnnaAppRuntime.connect();
    })(), CONNECT_TIMEOUT_MS, 'Anna 连接超时');
    if (typeof anna.llm?.complete !== 'function' || typeof anna.storage?.get !== 'function'
      || typeof anna.storage?.set !== 'function' || typeof anna.window?.set_title !== 'function'
      || typeof anna.files?.upload_init !== 'function' || typeof anna.files?.download !== 'function') {
      throw new Error('Anna SDK 缺少所需接口');
    }
    return createHostPlatform(anna);
  } catch {
    throw new Error('未能在 15 秒内连接 Anna。请刷新或从平台重新打开 App；本页不会自动切换成演示，也尚未发起 AI 请求。');
  }
}
