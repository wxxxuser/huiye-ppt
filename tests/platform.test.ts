import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostPlatform } from '../src/platform';
import { makeSampleDeck } from '../src/sample';
import type { CompletionRequest, Deck, ImageAsset, PreparedImage, WorkspaceDraft } from '../src/types';
import { emptyWorkspace, validateWorkspace } from '../src/workspace';

type Runtime = Parameters<typeof createHostPlatform>[0];
const request: CompletionRequest = {
  messages: [
    { role: 'system', content: { type: 'text', text: 'Return JSON.' } },
    { role: 'user', content: { type: 'text', text: '准备项目汇报。' } },
  ],
  maxTokens: 1200,
};
const response = { content: { type: 'text', text: '{"title":"项目汇报"}' }, stopReason: 'endTurn' };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected host call'); };
function runtime(): Runtime {
  return {
    llm: { complete: unexpected },
    storage: { get: unexpected, set: unexpected },
    files: { list: unexpected, upload_init: unexpected, upload_finalize: unexpected, download: unexpected, download_url: unexpected },
    window: { set_title: unexpected },
  };
}
function draft(title: string): Deck {
  const deck = makeSampleDeck();
  deck.title = title;
  deck.brief.title = title;
  deck.outline.title = title;
  return deck;
}
function hostError(code: string | number, message = 'Server diagnostic') {
  return Object.assign(new Error(message), { code });
}

test('complete sends one exact Anna request with bounded tokens and reasoning off', async () => {
  const anna = runtime();
  const calls: unknown[] = [];
  anna.llm.complete = async (args, options) => {
    calls.push({ args, options });
    return { ...response, model: 'user-selected-model', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, _meta: { quotaConsumed: 0.75 } };
  };
  const result = await createHostPlatform(anna).complete(request);
  assert.deepEqual(calls, [{ args: { ...request, thinking: false }, options: { timeoutMs: 180_000 } }]);
  assert.equal(result.model, 'user-selected-model');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  assert.equal(result._meta?.quotaConsumed, 0.75);
});

test('absent usage and quota are unknown rather than invented zero usage', async () => {
  const anna = runtime();
  anna.llm.complete = async () => response;
  const result = await createHostPlatform(anna).complete(request);
  assert.equal(result.usage?.inputTokens, undefined);
  assert.equal(result.usage?.outputTokens, undefined);
  assert.equal(result.usage?.totalTokens, undefined);
  assert.equal(result._meta?.quotaConsumed, undefined);
});

test('quota_exceeded describes AI credits for AI and storage capacity for storage', async () => {
  const anna = runtime();
  let calls = 0;
  anna.llm.complete = async () => { calls++; throw hostError('quota_exceeded'); };
  anna.storage.get = async () => { throw hostError('quota_exceeded'); };
  const platform = createHostPlatform(anna);
  await assert.rejects(platform.complete(request), error => {
    assert.match((error as Error).message, /额度不足/);
    assert.doesNotMatch((error as Error).message, /存储空间/);
    return true;
  });
  await assert.rejects(platform.loadDraft(), /存储空间不足/);
  assert.equal(calls, 1, 'quota failure must not trigger an automatic model retry');
});

for (const code of ['llm_disabled', 'not_implemented', -32601]) {
  test(`${code} asks for real Anna AI without returning a sample or retrying`, async () => {
    const anna = runtime();
    let calls = 0;
    anna.llm.complete = async () => { calls++; throw hostError(code); };
    const platform = createHostPlatform(anna);
    await assert.rejects(platform.complete(request), /当前环境未提供 Anna AI.*真实账号/);
    assert.equal(platform.mode, 'anna');
    assert.equal(calls, 1);
  });
}

test('APS saves are serialized and each subsequent write uses the new etag', async () => {
  const anna = runtime();
  const writes: { value: unknown; if_match?: string }[] = [];
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
  const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
  anna.storage.get = async args => {
    assert.deepEqual(args, { key: 'drafts/current-v1', scope: 'app' });
    return { exists: true, value: null, etag: 'etag-a' };
  };
  anna.storage.set = async args => {
    assert.equal(args.scope, 'app');
    assert.equal(args.key, 'drafts/current-v1');
    writes.push(args);
    if (writes.length === 1) {
      announceFirst();
      await firstMayFinish;
      return { etag: 'etag-b' };
    }
    return { etag: 'etag-c' };
  };
  const platform = createHostPlatform(anna);
  assert.equal(await platform.loadDraft(), null, 'stored-null remains a valid read');
  const first = platform.saveDraft(draft('第一版'));
  const secondDraft = draft('第二版');
  const second = platform.saveDraft(secondDraft);
  secondDraft.title = '排队后继续编辑';
  secondDraft.brief.title = '排队后继续编辑';
  secondDraft.slides[0].sourceIds.push('changed');
  await firstStarted;
  assert.equal(writes.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes.map(write => write.if_match), ['etag-a', 'etag-b']);
  assert.deepEqual(writes.map(write => (write.value as WorkspaceDraft).deck!.title), ['第一版', '第二版']);
  assert.equal((writes[1].value as WorkspaceDraft).brief.title, '第二版');
  assert.ok(!(writes[1].value as WorkspaceDraft).deck!.slides[0].sourceIds.includes('changed'), 'queued snapshots must be detached from later edits');
});

test('APS round trip restores unfinished material workspace without invoking AI', async () => {
  const anna = runtime();
  const calls: { method: string; args: unknown; options: unknown }[] = [];
  let stored: unknown = null;
  let etag = 'etag-empty';
  anna.storage.get = async (args, options) => {
    calls.push({ method: 'get', args, options });
    return { exists: true, value: stored, etag };
  };
  anna.storage.set = async (args, options) => {
    calls.push({ method: 'set', args, options });
    assert.equal(args.if_match, etag);
    stored = structuredClone(args.value);
    etag = 'etag-material';
    return { etag };
  };
  const workspace = emptyWorkspace();
  workspace.brief = { title: '', audience: '', goal: '', slideCount: 6, source: '尚未写完的项目材料' };
  const expected = structuredClone(workspace);
  const platform = createHostPlatform(anna);
  assert.equal(await platform.loadDraft(), null);
  const saving = platform.saveDraft(workspace);
  workspace.brief.source = '保存开始后继续输入';
  await saving;
  const reopened = createHostPlatform(anna);
  assert.deepEqual(validateWorkspace(await reopened.loadDraft()), expected);
  assert.deepEqual(calls, [
    { method: 'get', args: { key: 'drafts/current-v1', scope: 'app' }, options: { timeoutMs: 20_000 } },
    { method: 'set', args: { key: 'drafts/current-v1', value: expected, scope: 'app', if_match: 'etag-empty' }, options: { timeoutMs: 20_000 } },
    { method: 'get', args: { key: 'drafts/current-v1', scope: 'app' }, options: { timeoutMs: 20_000 } },
  ]);
});

function exportRuntime(events: string[]) {
  const anna = runtime();
  anna.files.list = async args => {
    events.push('list');
    assert.equal(args.prefix, 'exports/current.pptx');
    return { items: [{ path: 'exports/current.pptx', etag: 'previous-file' }] };
  };
  anna.files.upload_init = async args => {
    events.push('init');
    assert.deepEqual(args, {
      path: 'exports/current.pptx', content_type: 'application/pptx', size: 4,
      ttl_seconds: 600, if_match: 'previous-file',
    });
    return {
      put_url: 'https://example.r2.cloudflarestorage.com/file?signature=PRIVATE-UPLOAD-SIGNATURE',
      headers: { 'Content-Type': 'application/pptx', 'x-amz-meta-example': 'signed-value' },
    };
  };
  anna.files.upload_finalize = async args => {
    events.push('finalize');
    assert.deepEqual(args, { path: 'exports/current.pptx', size_bytes: 4, etag: 'object-etag' });
    return { path: 'exports/current.pptx', etag: 'new-file', size_bytes: 4 };
  };
  anna.files.download = async args => {
    events.push('download');
    assert.deepEqual(args, { path: 'exports/current.pptx', filename: '汇报.pptx' });
    return { ok: true };
  };
  return anna;
}

test('export completes signed PUT and finalize before requesting the HOST download', async t => {
  const events: string[] = [];
  const anna = exportRuntime(events);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    events.push('put');
    assert.equal(options.method, 'PUT');
    assert.equal(options.credentials, 'omit');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Content-Type'), 'application/pptx');
    assert.equal(headers.get('x-amz-meta-example'), 'signed-value');
    assert.deepEqual([...new Uint8Array(await (options.body as Blob).arrayBuffer())], [1, 2, 3, 4]);
    return new Response(null, { status: 200, headers: { ETag: 'object-etag' } });
  });
  await createHostPlatform(anna).saveFile(new Uint8Array([1, 2, 3, 4]), '汇报.pptx', 'application/pptx');
  assert.deepEqual(events, ['list', 'init', 'put', 'finalize', 'download']);
});

for (const failAt of ['put', 'finalize', 'download'] as const) {
  test(`export ${failAt} failure rejects and never pretends the download succeeded`, async t => {
    const events: string[] = [];
    const anna = exportRuntime(events);
    t.mock.method(globalThis, 'fetch', async () => {
      events.push('put');
      return new Response(null, { status: failAt === 'put' ? 403 : 200, headers: { ETag: 'object-etag' } });
    });
    if (failAt === 'finalize') anna.files.upload_finalize = async () => { events.push('finalize'); throw new Error('PRIVATE-TOKEN'); };
    if (failAt === 'download') anna.files.download = async () => { events.push('download'); return { ok: false }; };
    await assert.rejects(
      createHostPlatform(anna).saveFile(new Uint8Array([1, 2, 3, 4]), '汇报.pptx', 'application/pptx'),
      error => { assert.doesNotMatch((error as Error).message, /PRIVATE-TOKEN|PRIVATE-UPLOAD-SIGNATURE/); return true; },
    );
    const expected = ['list', 'init', 'put', 'finalize', 'download'];
    assert.deepEqual(events, expected.slice(0, expected.indexOf(failAt) + 1));
  });
}

test('provider diagnostics and unknown error codes cannot leak tokens', async () => {
  const anna = runtime();
  anna.llm.complete = async () => { throw hostError('secret-token-from-server', 'Bearer PRIVATE-TOKEN https://host/?t=PRIVATE-TOKEN'); };
  await assert.rejects(createHostPlatform(anna).complete(request), error => {
    const message = (error as Error).message;
    assert.match(message, /AI 生成失败/);
    assert.doesNotMatch(message, /PRIVATE-TOKEN|secret-token|Bearer|https:/);
    return true;
  });
});

const imageBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64'));
function imageInput(): PreparedImage {
  return { blob: new Blob([imageBytes], { type: 'image/png' }), name: '验收图片.png', width: 1, height: 1 };
}
function imageAsset(): ImageAsset {
  const id = 'img-00000000-0000-4000-8000-000000000001';
  return { id, path: `assets/${id}.png`, mimeType: 'image/png', name: '验收图片.png', width: 1, height: 1, sizeBytes: imageBytes.length };
}

test('images upload immutable bytes before publishing a stable reference, without LLM or download calls', async t => {
  const anna = runtime();
  const events: string[] = [];
  let path = '';
  anna.files.upload_init = async args => {
    events.push('init'); path = args.path;
    assert.match(path, /^assets\/img-[a-f0-9-]{36}\.png$/);
    assert.equal(args.content_type, 'image/png'); assert.equal(args.size, imageBytes.length);
    assert.equal(args.if_match, undefined, 'new assets never overwrite bytes needed by undo');
    return { put_url: 'https://example.r2.cloudflarestorage.com/image?secret=HIDDEN', headers: { 'Content-Type': 'image/png', 'x-signed': 'preserve-me' } };
  };
  t.mock.method(globalThis, 'fetch', async (_url, options: RequestInit) => {
    events.push('put');
    assert.equal(options.method, 'PUT'); assert.equal(options.credentials, 'omit');
    assert.equal(new Headers(options.headers).get('x-signed'), 'preserve-me');
    assert.deepEqual(new Uint8Array(await (options.body as Blob).arrayBuffer()), imageBytes);
    return new Response(null, { headers: { ETag: 'image-etag' } });
  });
  anna.files.upload_finalize = async args => {
    events.push('finalize');
    assert.deepEqual(args, { path, size_bytes: imageBytes.length, etag: 'image-etag' });
    return { path, etag: 'final', size_bytes: imageBytes.length };
  };
  const input = imageInput();
  const pending = createHostPlatform(anna).saveImage(input);
  input.name = 'later.png'; input.width = 999;
  const asset = await pending;
  assert.equal(asset.name, '验收图片.png'); assert.equal(asset.width, 1);
  assert.equal(asset.path, path); assert.equal(asset.sizeBytes, imageBytes.length);
  assert.doesNotMatch(JSON.stringify(asset), /HIDDEN|https:/);
  assert.deepEqual(events, ['init', 'put', 'finalize']);
});

test('restored image assets receive a new download URL and fetch verified bounded bytes', async t => {
  const anna = runtime(); const asset = imageAsset(); let signedCalls = 0;
  anna.files.download_url = async args => {
    signedCalls++; assert.deepEqual(args, { path: asset.path, ttl_seconds: 600 });
    return { get_url: `https://example.r2.cloudflarestorage.com/image?signature=${signedCalls}`, size_bytes: asset.sizeBytes, content_type: asset.mimeType };
  };
  t.mock.method(globalThis, 'fetch', async (_url, options: RequestInit) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });
  });
  const platform = createHostPlatform(anna);
  assert.deepEqual(new Uint8Array(await (await platform.loadImage(asset)).arrayBuffer()), imageBytes);
  await platform.loadImage(asset);
  assert.equal(signedCalls, 2);
});

test('invalid prepared pixels and unsafe image references fail before any Anna request', async () => {
  const platform = createHostPlatform(runtime());
  await assert.rejects(platform.saveImage({ ...imageInput(), width: 2 }), /内容与保存记录不一致/);
  await assert.rejects(platform.saveImage({ ...imageInput(), blob: new Blob(['<svg/>'], { type: 'image/png' }) }), /请选择有效/);
  await assert.rejects(platform.loadImage({ ...imageAsset(), path: '../other-user.png' }), /引用格式/);
});

for (const failure of ['put', 'finalize', 'download', 'oversize', 'mime'] as const) {
  test(`image ${failure} failure cannot leak signed URLs or return a successful asset`, async t => {
    const anna = runtime(); const asset = imageAsset(); let finalized = false;
    anna.files.upload_init = async () => ({ put_url: 'https://example.r2.cloudflarestorage.com/?signature=SECRET', headers: {} });
    anna.files.upload_finalize = async args => { finalized = true; throw new Error(`SECRET ${args.path}`); };
    anna.files.download_url = async () => ({ get_url: 'https://example.r2.cloudflarestorage.com/?signature=SECRET' });
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'put' || failure === 'download') throw new Error('fetch SECRET');
      if (failure === 'oversize') return new Response(new Uint8Array(asset.sizeBytes + 1), { headers: { 'Content-Type': 'image/png' } });
      if (failure === 'mime') return new Response(imageBytes, { headers: { 'Content-Type': 'image/svg+xml' } });
      return new Response(null, { headers: { ETag: 'image-etag' } });
    });
    const platform = createHostPlatform(anna);
    const operation = failure === 'put' || failure === 'finalize' ? platform.saveImage(imageInput()) : platform.loadImage(asset);
    await assert.rejects(operation, error => { assert.doesNotMatch((error as Error).message, /SECRET|https:/); return true; });
    assert.equal(finalized, failure === 'finalize');
  });
}
