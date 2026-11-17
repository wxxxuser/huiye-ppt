import PptxGenJS from 'pptxgenjs';
import type { Deck } from './types';
import { createSlideScene, SLIDE_FONT, SLIDE_FONT_LATIN } from './presentation';

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function safePptxFilename(title: string): string {
  const cleaned = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '').replace(/\.pptx$/i, '');
  const stem = Array.from(cleaned).slice(0, 100).join('') || '汇页演示文稿';
  return `${/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem) ? '_' : ''}${stem}.pptx`;
}

export function getPptxFilename(deck: Deck): string {
  return safePptxFilename(deck.title);
}

/** Builds editable native text boxes and shapes. No rasterized slides or network calls. */
export async function buildPptx(deck: Deck, imageData: Record<string, string> = {}): Promise<Uint8Array> {
  if (!deck.slides.length) throw new Error('请先添加至少一页幻灯片。');
  for (const [index, slide] of deck.slides.entries()) {
    if (slide.layout !== 'image') continue;
    if (!slide.image) throw new Error(`第 ${index + 1} 页尚未添加图片，请上传图片或切换版式后导出。`);
    if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData[slide.image.asset.id] ?? '')) {
      throw new Error(`第 ${index + 1} 页的图片尚未读取成功，请重新加载或替换图片后导出。`);
    }
  }
  const scenes = deck.slides.map((slide, index) => createSlideScene(slide, deck.theme, index, deck.slides.length));
  const overflow = scenes.flatMap((scene, index) => scene.issues.filter(issue => issue.severity === 'error').map(issue => `第 ${index + 1} 页：${issue.message}`));
  if (overflow.length) throw new Error(`暂时无法导出：${[...new Set(overflow)].join('\n')}`);
  // PptxGenJS 4 exposes both CJS and ESM; tsx's interop can add a default layer.
  const Constructor = typeof PptxGenJS === 'function' ? PptxGenJS
    : (PptxGenJS as unknown as { default: typeof PptxGenJS }).default;
  const pptx = new Constructor();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = '汇页 PPT';
  pptx.subject = deck.subtitle || deck.brief.goal;
  pptx.title = deck.title;
  pptx.company = '汇页 PPT';
  pptx.theme = { headFontFace: SLIDE_FONT_LATIN, bodyFontFace: SLIDE_FONT_LATIN };

  deck.slides.forEach((slide, index) => {
    const output = pptx.addSlide();
    const scene = scenes[index];
    output.background = { color: scene.background.slice(1) };
    for (const element of scene.elements) {
      const { x, y, w, h } = element;
      if (element.kind === 'shape') {
        const shape = element.shape === 'line' ? pptx.ShapeType.line : element.shape === 'ellipse' ? pptx.ShapeType.ellipse : pptx.ShapeType.rect;
        output.addShape(shape, { x, y, w, h,
          line: { color: element.color.slice(1), width: element.shape === 'line' ? 0.65 : 0 },
          fill: { color: element.color.slice(1) },
          objectName: `汇页 ${element.shape}` });
      } else if (element.kind === 'image') {
        const data = imageData[element.assetId!];
        const ratio = element.sourceWidth / element.sourceHeight;
        if (element.fit === 'contain') {
          // Use an explicit contained rectangle: no stretching or negative crop.
          const imageW = Math.min(w, h * ratio);
          const imageH = imageW / ratio;
          output.addShape(pptx.ShapeType.rect, { x, y, w, h, line: { color: element.background.slice(1), width: 0 }, fill: { color: element.background.slice(1) } });
          output.addImage({ data, x: x + (w - imageW) / 2, y: y + (h - imageH) / 2,
            w: imageW, h: imageH, altText: element.name || slide.title, objectName: '汇页 页面配图' });
        } else {
          // PptxGenJS 4 uses the w/h aspect ratio as the image's intrinsic ratio;
          // sizing supplies the final rectangle and generates symmetric crop XML.
          const longestEdge = Math.max(element.sourceWidth, element.sourceHeight);
          output.addImage({ data, x, y, w: element.sourceWidth / longestEdge, h: element.sourceHeight / longestEdge, sizing: { type: 'cover', w, h },
            altText: element.name || slide.title, objectName: '汇页 页面配图' });
        }
      } else {
        output.addText(element.lines.join('\n'), {
          x, y, w, h, fontFace: /[^\u0000-\u007f]/.test(element.text) ? SLIDE_FONT : SLIDE_FONT_LATIN,
          fontSize: element.fontSize, color: element.color.slice(1), bold: element.bold,
          align: element.align, valign: 'top', margin: 0, breakLine: false,
          lineSpacingMultiple: element.lineHeight, paraSpaceAfter: 0, paraSpaceBefore: 0,
          // Explicit user sizes must not be silently re-fitted by PowerPoint.
          wrap: true, fit: element.fontSizeExplicit ? 'none' : 'shrink', lang: 'zh-CN',
          objectName: `汇页 ${element.role}`,
        });
      }
    }
    const sourceNotes = slide.sourceIds.map(id => {
      const block = deck.sourceBlocks.find(source => source.id === id);
      return `[${id}] ${block?.text ?? '来源标记未匹配到原始材料，请核对。'}`;
    });
    output.addNotes([
      slide.speakerNotes || '（未填写讲稿备注）',
      ...(sourceNotes.length ? ['\n来源材料', ...sourceNotes] : []),
      '\n完整页面文字（供无损核对）', slide.title, slide.subtitle, ...slide.body,
    ].filter(Boolean).join('\n'));
  });

  const result = await pptx.write({ outputType: 'uint8array', compression: true });
  if (!(result instanceof Uint8Array)) throw new Error('PPTX 导出返回了无法识别的文件格式。');
  return result;
}

export async function downloadPptx(deck: Deck, imageData: Record<string, string> = {}): Promise<void> {
  const bytes = await buildPptx(deck, imageData);
  const blob = new Blob([new Uint8Array(bytes)], { type: PPTX_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = getPptxFilename(deck);
  link.style.display = 'none';
  document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    // Browsers start the download asynchronously; keep the URL alive briefly.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
