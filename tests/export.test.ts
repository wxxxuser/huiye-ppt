import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildPptx, safePptxFilename } from '../src/export-pptx.ts';
import { createSlideScene, diagnoseSlide, THEMES } from '../src/presentation.ts';
import type { Deck, Layout, Slide, ThemeId } from '../src/types.ts';

const layouts: Layout[] = ['cover', 'bullets', 'split', 'steps', 'closing'];
const slide: Slide = {
  id: 'slide-1', title: '项目汇报：从材料到行动', subtitle: '保留依据，让表达更清晰',
  body: ['明确本次汇报的目标与受众。', '所有数据应有可追溯的材料依据。', '下一步：确认负责人和完成时间。'],
  speakerNotes: '讲稿备注：请强调这是一份可编辑的 PowerPoint。', sourceIds: ['S1'], layout: 'bullets',
};
const deck: Deck = {
  id: 'test-deck', title: '中文 & Editable PPT', subtitle: '五种版式的完整导出', theme: 'ink',
  slides: layouts.map((layout, index) => ({ ...slide, id: `s${index}`, layout })),
  brief: { title: '中文汇报', audience: '评审', goal: '检验真实导出', slideCount: 5, source: '原始材料：已完成第一阶段。' },
  outline: { title: '中文汇报', subtitle: '', slides: [] },
  sourceBlocks: [{ id: 'S1', text: '原始材料：已完成第一阶段，负责人张三。' }],
  usage: [], createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
};

test('exports editable slides without corner labels and keeps source material in speaker notes', async () => {
  const data = await buildPptx(deck);
  assert.ok(data instanceof Uint8Array);
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 5);
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  assert.match(presentation, /cx="12192000" cy="6858000"/);
  assert.equal(Object.keys(zip.files).filter(name => name.startsWith('ppt/media/') && !zip.files[name].dir).length, 0, 'no screenshot media');
  for (let index = 1; index <= 5; index++) {
    const xml = await zip.file(`ppt/slides/slide${index}.xml`)!.async('string');
    assert.match(xml, /<p:sp>/, 'native editable shapes');
    assert.match(xml, /<a:t>项目汇报：从材料到行动<\/a:t>/);
    assert.doesNotMatch(xml, /<a:t>来源\s|<a:t>S1<\/a:t>|name="汇页 sources"/);
    assert.doesNotMatch(xml, /<a:t>(封面|要点|双栏|步骤|收尾)<\/a:t>/);
    assert.match(xml, /Microsoft YaHei/);
    assert.doesNotMatch(xml, /<p:pic>/);
    const editableText = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(match => match[1]).join('').replace(/\s+/g, '');
    for (const body of slide.body) assert.ok(editableText.includes(body.replace(/\s+/g, '')), 'body is preserved in editable text shapes');
    const notes = await zip.file(`ppt/notesSlides/notesSlide${index}.xml`)!.async('string');
    assert.match(notes, /讲稿备注：请强调这是一份可编辑的 PowerPoint。/);
    assert.match(notes, /原始材料：已完成第一阶段，负责人张三。/);
  }
});

test('all themes and layouts retain all content, including maximum expected Chinese body text', async () => {
  const longBody = Array.from({ length: 4 }, (_, index) => `${index + 1}、${'项目进展必须根据原始材料进行准确说明'.repeat(5)}`.slice(0, 90));
  for (const theme of Object.keys(THEMES) as ThemeId[]) {
    const slides = layouts.map((layout, index) => ({ ...slide, id: `${layout}-${index}`, layout, body: longBody,
      title: '项目材料与业务决策需要建立清晰联系'.repeat(5).slice(0, 60),
      subtitle: '基于可追溯的真实材料说明结论及后续行动'.repeat(6).slice(0, 100),
    }));
    for (const item of slides) {
      const scene = createSlideScene(item, theme, 0, 5);
      assert.equal(scene.issues.some(issue => issue.severity === 'error'), false, `${theme}/${item.layout} should fit`);
      const allText = scene.elements.filter(element => element.kind === 'text').map(element => element.text).join('\n');
      for (const body of longBody) assert.ok(allText.includes(body), 'the layout must not truncate the source');
    }
    const zip = await JSZip.loadAsync(await buildPptx({ ...deck, theme, slides }));
    const notes = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
    for (const body of longBody) assert.ok(notes.includes(body), 'notes retain the exact original text');
  }
});

test('overflow is diagnosed and blocks a silently clipped export', async () => {
  const overlong = { ...slide, body: ['长内容'.repeat(400)] };
  assert.ok(diagnoseSlide(overlong).some(issue => issue.severity === 'error'));
  await assert.rejects(() => buildPptx({ ...deck, slides: [overlong] }), /第 1 页/);
  await assert.rejects(() => buildPptx({ ...deck, slides: [] }), /至少一页/);
});

test('download filenames are safe across Windows and browsers', () => {
  assert.equal(safePptxFilename('  汇报:第一期/结果?  '), '汇报_第一期_结果_.pptx');
  assert.equal(safePptxFilename('CON'), '_CON.pptx');
  assert.equal(safePptxFilename('..'), '汇页演示文稿.pptx');
  assert.equal(safePptxFilename('文件.pptx'), '文件.pptx');
});

test('PPTX keeps explicit title, subtitle and body sizes without automatic shrinking', async () => {
  const typography = { titleSize: 44, subtitleSize: 26, bodySize: 29 };
  const manual = { ...slide, title: '字号测试', subtitle: '核心信息', body: ['原生正文对象'], typography };
  const zip = await JSZip.loadAsync(await buildPptx({ ...deck, slides: [manual] }));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const shapes = xml.match(/<p:sp>.*?<\/p:sp>/gs)!;
  for (const [role, size] of [['title', 44], ['subtitle', 26], ['body-0', 29]] as const) {
    const shape = shapes.find(shape => shape.includes(`name="汇页 ${role}"`))!;
    assert.ok(shape, `editable ${role} object exists`);
    assert.match(shape, new RegExp(`<a:rPr[^>]*sz="${size * 100}"`));
    assert.doesNotMatch(shape, /<a:normAutofit|<a:spAutoFit/, 'PowerPoint cannot silently resize explicit text');
  }
  const legacyZip = await JSZip.loadAsync(await buildPptx({ ...deck, slides: [{ ...manual, typography: undefined }] }));
  assert.match(await legacyZip.file('ppt/slides/slide1.xml')!.async('string'), /<a:normAutofit/, 'old auto-fit behavior is retained');
});

test('oversized manual typography blocks export instead of reducing the requested size', async () => {
  for (const manual of [
    { ...slide, title: '标题'.repeat(30), typography: { titleSize: 64 } },
    { ...slide, subtitle: '核心信息'.repeat(25), typography: { subtitleSize: 36 } },
    { ...slide, body: Array.from({ length: 4 }, () => '正文'.repeat(45)), typography: { bodySize: 40 } },
  ]) await assert.rejects(buildPptx({ ...deck, slides: [manual] }), /第 1 页.*pt 下超出/);
});

// Real 16×8 two-colour raster fixtures, encoded once without any network service.
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAHklEQVR4nGOUzJvNgA2c1ViNVZyJgUTANKqBgTAAABowAtJ2u4ybAAAAAElFTkSuQmCC';
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDma9LoorDiT/l1/wBvfoHDX/L3/t39T//Z';
function imageSlide(format: 'png' | 'jpeg' = 'png'): Slide {
  return { ...slide, layout: 'image', image: {
    asset: { id: `img-${format}`, path: `assets/${format}.${format}`, name: `测试配图.${format}`,
      mimeType: `image/${format}`, width: 16, height: 8, sizeBytes: Buffer.from(format === 'png' ? png : jpeg, 'base64').byteLength },
    fit: 'contain', side: 'left',
  } };
}

test('image slides embed PNG/JPEG bytes and image relationships while keeping text editable', async () => {
  const pngSlide = imageSlide();
  const jpegSlide = imageSlide('jpeg');
  jpegSlide.image!.fit = 'cover';
  jpegSlide.image!.side = 'right';
  const zip = await JSZip.loadAsync(await buildPptx({ ...deck, slides: [pngSlide, jpegSlide] }, {
    'img-png': `data:image/png;base64,${png}`, 'img-jpeg': `data:image/jpeg;base64,${jpeg}`,
  }));
  const media = Object.keys(zip.files).filter(name => name.startsWith('ppt/media/') && !zip.files[name].dir);
  assert.equal(media.length, 2);
  assert.deepEqual(await zip.file(media.find(name => name.endsWith('.png'))!)!.async('nodebuffer'), Buffer.from(png, 'base64'));
  assert.deepEqual(await zip.file(media.find(name => name.endsWith('.jpeg'))!)!.async('nodebuffer'), Buffer.from(jpeg, 'base64'));
  for (let page = 1; page <= 2; page++) {
    const xml = await zip.file(`ppt/slides/slide${page}.xml`)!.async('string');
    assert.equal((xml.match(/<p:pic>/g) ?? []).length, 1, 'one native picture object, not a flattened page');
    assert.match(xml, /<p:sp>/);
    assert.match(xml, /<a:t>项目汇报：从材料到行动<\/a:t>/);
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(match => match[1]).join('').replace(/\s+/g, '');
    for (const body of slide.body) assert.ok(text.includes(body.replace(/\s+/g, '')));
    const rels = await zip.file(`ppt/slides/_rels/slide${page}.xml.rels`)!.async('string');
    assert.match(rels, /relationships\/image/);
    assert.match(rels, /Target="\.\.\/media\//);
    assert.doesNotMatch(rels, /TargetMode="External"/);
  }
});

test('contain fits the original ratio; cover exports matching symmetric crop and right alignment', async () => {
  const item = imageSlide();
  const scene = createSlideScene(item, 'paper', 0, 1);
  const frame = scene.elements.find(element => element.kind === 'image')!;
  assert.equal(frame.kind, 'image');
  const expectedWidth = Math.min(frame.w, frame.h * 2);
  const expectedHeight = expectedWidth / 2;
  const contained = await JSZip.loadAsync(await buildPptx({ ...deck, slides: [item] }, { 'img-png': `data:image/png;base64,${png}` }));
  const xml = (await contained.file('ppt/slides/slide1.xml')!.async('string')).match(/<p:pic>.*?<\/p:pic>/s)![0];
  const dimensions = [...xml.matchAll(/<a:ext cx="(\d+)" cy="(\d+)"\/>/g)].at(-1)!;
  assert.ok(Math.abs(Number(dimensions[1]) - expectedWidth * 914400) <= 1);
  assert.ok(Math.abs(Number(dimensions[2]) - expectedHeight * 914400) <= 1);
  assert.doesNotMatch(xml, /<a:srcRect/);
  item.image!.fit = 'cover'; item.image!.side = 'right';
  const switched = createSlideScene(item, 'paper', 0, 1).elements;
  const switchedFrame = switched.find(element => element.kind === 'image')!;
  const body = switched.find(element => element.kind === 'text' && element.role === 'body-0')!;
  assert.ok(switchedFrame.x > body.x, 'image on right, editable text on left');
  const covered = await JSZip.loadAsync(await buildPptx({ ...deck, slides: [item] }, { 'img-png': `data:image/png;base64,${png}` }));
  const coverXml = await covered.file('ppt/slides/slide1.xml')!.async('string');
  const crop = coverXml.match(/<a:srcRect l="(\d+)" r="(\d+)" t="(\d+)" b="(\d+)"/)!;
  assert.equal(crop[1], crop[2]); assert.equal(crop[3], crop[4]);
  assert.ok(Number(crop[1]) > 0, 'a wide photo is centrally cropped to fill the frame');
});

test('image layout wraps long content, diagnoses overflow, and does not discard text', async () => {
  const item = imageSlide();
  item.body = Array.from({ length: 3 }, () => '根据门店订单与取餐记录分析高峰期的等待情况。'.repeat(5).slice(0, 90));
  for (const theme of Object.keys(THEMES) as ThemeId[]) {
    const scene = createSlideScene(item, theme, 0, 1);
    assert.equal(scene.issues.some(issue => issue.severity === 'error'), false);
    const text = scene.elements.filter(element => element.kind === 'text').map(element => element.text);
    for (const body of item.body) assert.ok(text.includes(body));
  }
  const overlong = { ...item, body: ['图片旁边的正文过长'.repeat(100)] };
  assert.ok(diagnoseSlide(overlong).some(issue => issue.severity === 'error'));
  await assert.rejects(buildPptx({ ...deck, slides: [overlong] }, { 'img-png': `data:image/png;base64,${png}` }), /超出/);
});

test('image export rejects missing attachments or data instead of silently losing pictures', async () => {
  await assert.rejects(buildPptx({ ...deck, slides: [{ ...slide, layout: 'image' }] }), /尚未添加图片/);
  await assert.rejects(buildPptx({ ...deck, slides: [imageSlide()] }), /图片尚未读取成功/);
  await assert.rejects(buildPptx({ ...deck, slides: [imageSlide()] }, { 'img-png': 'https://example.test/image.png' }), /图片尚未读取成功/);
  const hiddenAttachment = { ...imageSlide(), layout: 'bullets' as const };
  const zip = await JSZip.loadAsync(await buildPptx({ ...deck, slides: [hiddenAttachment] }));
  assert.equal(Object.keys(zip.files).filter(name => name.startsWith('ppt/media/') && !zip.files[name].dir).length, 0);
  assert.ok(hiddenAttachment.image, 'switching layout never deletes the image attachment');
});
