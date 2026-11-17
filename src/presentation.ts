import type { Layout, Slide, SlideTypography, ThemeId } from './types';
export { TYPOGRAPHY_RANGES } from './types';

export interface PresentationTheme {
  name: string;
  background: string;
  text: string;
  muted: string;
  accent: string;
  surface: string;
  line: string;
}

export const THEMES: Record<ThemeId, PresentationTheme> = {
  ink: { name: '深蓝', background: '#122039', text: '#F4F7FC', muted: '#A8B9D2', accent: '#86CEFF', surface: '#1D304D', line: '#344763' },
  paper: { name: '米白', background: '#FAF6EE', text: '#332D29', muted: '#7C7165', accent: '#AE6138', surface: '#F0E7DA', line: '#DED1C1' },
  forest: { name: '深绿', background: '#143B30', text: '#F0FAF4', muted: '#AECCBA', accent: '#A0E6BE', surface: '#204D3D', line: '#3B6551' },
};

export const LAYOUT_NAMES: Record<Layout, string> = {
  cover: '封面', bullets: '要点', split: '双栏', steps: '步骤', closing: '收尾', image: '图文',
};
export const SLIDE_WIDTH = 40 / 3;
export const SLIDE_HEIGHT = 7.5;
export const SLIDE_FONT = 'Microsoft YaHei';
export const SLIDE_FONT_LATIN = 'Aptos';

interface Box { x: number; y: number; w: number; h: number }
export interface TextElement extends Box {
  kind: 'text'; text: string; lines: string[]; fontSize: number; lineHeight: number;
  color: string; bold?: boolean; align?: 'left' | 'center' | 'right'; role: string;
  fontSizeExplicit: boolean;
}
export interface ShapeElement extends Box {
  kind: 'shape'; shape: 'rect' | 'ellipse' | 'line'; color: string;
}
export interface ImageElement extends Box {
  kind: 'image'; assetId: string | null; name: string;
  sourceWidth: number; sourceHeight: number; fit: 'contain' | 'cover';
  background: string; color: string;
}
export type SlideElement = TextElement | ShapeElement | ImageElement;
export interface SlideIssue {
  field: 'title' | 'subtitle' | 'body' | 'sourceIds' | 'image';
  severity: 'warning' | 'error'; message: string;
}
export interface SlideScene { background: string; elements: SlideElement[]; issues: SlideIssue[] }

// A deterministic, conservative width estimate keeps SVG and PowerPoint wrapping
// identical. PPTX still contains ordinary text boxes, not vector outlines.
function characterWidth(char: string): number {
  if (/\s/u.test(char)) return 0.34;
  if (/^[\u0020-\u007e]$/u.test(char)) {
    if (/[ilI.,:;'!|]/u.test(char)) return 0.3;
    if (/[MW@%]/u.test(char)) return 0.9;
    return 0.58;
  }
  return 1.02;
}

export function wrapText(text: string, widthInches: number, fontSize: number): string[] {
  const limit = Math.max(1, widthInches * 72 / fontSize);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    let width = 0;
    for (const char of Array.from(paragraph)) {
      const next = characterWidth(char);
      if (line && width + next > limit) {
        // Prefer a word boundary for Latin prose, without removing whitespace.
        const lastSpace = line.lastIndexOf(' ');
        if (lastSpace > line.length * 0.55 && /^[A-Za-z0-9]/.test(char)) {
          lines.push(line.slice(0, lastSpace + 1));
          line = line.slice(lastSpace + 1);
          width = Array.from(line).reduce((sum, ch) => sum + characterWidth(ch), 0);
        } else {
          lines.push(line); line = ''; width = 0;
        }
      }
      line += char; width += next;
    }
    lines.push(line);
  }
  return lines;
}

function contentSize(slide: Slide): number {
  return slide.body.reduce((sum, line) => sum + Array.from(line).length, 0);
}

function isDenseHero(slide: Slide): boolean {
  return contentSize(slide) > 140 || slide.body.length > 2 || slide.subtitle.length > 70;
}

/** Starting sizes for automatic layout; dense text may auto-fit below these values. */
export function getDefaultSlideTypography(slide: Slide): SlideTypography {
  const hero = slide.layout === 'cover' || slide.layout === 'closing';
  if (hero && !isDenseHero(slide)) return { titleSize: 42, subtitleSize: 21, bodySize: 20 };
  const count = Math.max(1, slide.body.length);
  const bodySize = slide.layout === 'image' ? (count <= 2 ? 25 : 22)
    : slide.layout === 'split' || slide.layout === 'steps' ? 22
    : count <= 2 ? 27 : 23;
  return { titleSize: hero ? 36 : 34, subtitleSize: 18, bodySize };
}

/** Each manual override is independent: editing body size keeps title auto-fit. */
export function getSlideTypography(slide: Slide): SlideTypography {
  return { ...getDefaultSlideTypography(slide), ...slide.typography };
}

/** All geometry is in inches; font sizes and line spacing are in points. */
export function createSlideScene(slide: Slide, theme: ThemeId, index: number, total: number): SlideScene {
  const palette = THEMES[theme];
  const scene: SlideScene = { background: palette.background, elements: [], issues: [] };
  const shape = (shapeType: ShapeElement['shape'], color: string, x: number, y: number, w: number, h: number) => {
    scene.elements.push({ kind: 'shape', shape: shapeType, color, x, y, w, h });
  };
  const text = (
    value: string, box: Box, role: string, size: number, minimum: number,
    options: { color?: string; bold?: boolean; align?: TextElement['align']; lineHeight?: number } = {},
  ) => {
    if (!value) return;
    const lineHeight = options.lineHeight ?? 1.16;
    const typographyField = role === 'title' ? 'titleSize' : role === 'subtitle' ? 'subtitleSize' : role.startsWith('body') ? 'bodySize' : null;
    const manualSize = typographyField ? slide.typography?.[typographyField] : undefined;
    const fontSizeExplicit = manualSize !== undefined;
    let fontSize = manualSize ?? size;
    let lines = wrapText(value, box.w, fontSize);
    while (!fontSizeExplicit && fontSize > minimum && lines.length * fontSize * lineHeight > box.h * 72) {
      fontSize -= 0.5;
      lines = wrapText(value, box.w, fontSize);
    }
    if (lines.length * fontSize * lineHeight > box.h * 72 + 0.1) {
      const field: SlideIssue['field'] = role.startsWith('body') ? 'body' : role === 'title' ? 'title' : role === 'sources' ? 'sourceIds' : 'subtitle';
      if (role !== 'brand' && role !== 'page') {
        scene.issues.push({ field, severity: 'error', message: `${field === 'body' ? '正文' : field === 'title' ? '标题' : field === 'subtitle' ? '核心信息' : '来源标记'}${fontSizeExplicit ? `在 ${fontSize} pt 下` : ''}超出当前版式，请减小字号、拆分内容或切换版式。完整文字仍保留在编辑器中。` });
      }
    } else if (fontSize <= 16.5 && (role === 'title' || role.startsWith('body'))) {
      scene.issues.push({ field: role === 'title' ? 'title' : 'body', severity: 'warning', message: fontSizeExplicit
        ? '当前手动字号较小，投影时可能不易阅读；建议精简内容并适当增大字号。'
        : '本页内容较多，字号已自动缩小；建议精简或拆成两页，提升投影可读性。' });
    }
    scene.elements.push({ kind: 'text', ...box, text: value, lines, role, fontSize, lineHeight, fontSizeExplicit,
      color: options.color ?? palette.text, bold: options.bold, align: options.align ?? 'left' });
  };

  shape('rect', palette.accent, 0.76, 0.48, 0.28, 0.055);
  text('汇页  /  HUIYE', { x: 1.15, y: 0.42, w: 3, h: 0.22 }, 'brand', 9, 9, { color: palette.muted });

  const hero = slide.layout === 'cover' || slide.layout === 'closing';
  const denseHero = hero && isDenseHero(slide);
  if (hero && !denseHero) {
    shape('rect', palette.accent, 11.86, 1.48, 0.12, 4.55);
    shape('rect', palette.surface, 12.14, 1.48, 0.38, 3.2);
    text(slide.title, { x: 0.78, y: 1.48, w: 10.6, h: 2.1 }, 'title', 42, 28, { bold: true, lineHeight: 1.16 });
    text(slide.subtitle, { x: 0.82, y: 3.94, w: 10.45, h: 0.96 }, 'subtitle', 21, 16, { color: palette.muted });
    text(slide.body.join('\n'), { x: 0.82, y: 5.14, w: 10.4, h: 1.18 }, 'body-0', 20, 16, { color: palette.accent });
  } else {
    text(slide.title, { x: 0.76, y: 1.02, w: 11.8, h: 1.19 }, 'title', hero ? 36 : 34, 22, { bold: true });
    text(slide.subtitle, { x: 0.79, y: 2.37, w: 11.72, h: 0.71 }, 'subtitle', 18, 16, { color: palette.muted });
    const bodyTop = slide.layout === 'image' ? 3.12 : 3.24;
    const bodyHeight = slide.layout === 'image' ? 3.38 : 3.22;
    if (slide.layout === 'image') {
      const attachment = slide.image;
      const imageX = attachment?.side === 'right' ? 6.81 : 0.76;
      const textX = attachment?.side === 'right' ? 0.76 : 6.81;
      scene.elements.push({
        kind: 'image', x: imageX, y: bodyTop, w: 5.75, h: bodyHeight,
        assetId: attachment?.asset.id ?? null, name: attachment?.asset.name ?? '',
        sourceWidth: attachment?.asset.width ?? 1, sourceHeight: attachment?.asset.height ?? 1,
        fit: attachment?.fit ?? 'contain', background: palette.surface, color: palette.muted,
      });
      if (!attachment) scene.issues.push({ field: 'image', severity: 'warning', message: '图文页尚未添加图片，请上传图片后导出。' });
      const gap = 0.1;
      const count = Math.max(1, slide.body.length);
      const rowHeight = (bodyHeight - gap * (count - 1)) / count;
      slide.body.forEach((item, itemIndex) => {
        const y = bodyTop + itemIndex * (rowHeight + gap);
        shape('rect', palette.accent, textX, y + 0.12, 0.06, 0.18);
        text(item, { x: textX + 0.26, y, w: 5.49, h: rowHeight }, `body-${itemIndex}`, count <= 2 ? 25 : 22, 16);
      });
    } else if (slide.layout === 'split' && slide.body.length > 0) {
      const middle = Math.ceil(slide.body.length / 2);
      [slide.body.slice(0, middle), slide.body.slice(middle)].forEach((items, column) => {
        const x = 0.76 + column * 6.05;
        shape('rect', palette.surface, x, bodyTop, 5.75, bodyHeight);
        shape('rect', palette.accent, x, bodyTop, 0.05, bodyHeight);
        const gap = 0.12;
        const rowHeight = (bodyHeight - 0.34 - Math.max(0, items.length - 1) * gap) / Math.max(1, items.length);
        items.forEach((item, itemIndex) => {
          text(item, { x: x + 0.28, y: bodyTop + 0.17 + itemIndex * (rowHeight + gap), w: 5.17, h: rowHeight }, `body-${column * middle + itemIndex}`, 22, 16);
        });
      });
    } else if (slide.layout === 'steps' && slide.body.length > 0) {
      const columns = slide.body.length === 1 ? 1 : 2;
      const rows = Math.ceil(slide.body.length / columns);
      const gap = 0.18;
      const cardWidth = columns === 1 ? 11.8 : 5.8;
      const cardHeight = (bodyHeight - gap * (rows - 1)) / rows;
      slide.body.forEach((item, itemIndex) => {
        const x = 0.76 + (itemIndex % columns) * (cardWidth + 0.2);
        const y = bodyTop + Math.floor(itemIndex / columns) * (cardHeight + gap);
        shape('rect', palette.surface, x, y, cardWidth, cardHeight);
        text(String(itemIndex + 1).padStart(2, '0'), { x: x + 0.2, y: y + 0.14, w: 0.47, h: 0.4 }, 'brand', 19, 19, { color: palette.accent, bold: true });
        text(item, { x: x + 0.83, y: y + 0.1, w: cardWidth - 1.04, h: cardHeight - 0.2 }, `body-${itemIndex}`, 22, 16);
      });
    } else {
      const gap = 0.13;
      const count = Math.max(1, slide.body.length);
      const rowHeight = (bodyHeight - gap * (count - 1)) / count;
      slide.body.forEach((item, itemIndex) => {
        const y = bodyTop + itemIndex * (rowHeight + gap);
        shape('rect', palette.accent, 0.81, y + 0.12, 0.08, 0.2);
        text(item, { x: 1.17, y, w: 11.27, h: rowHeight }, `body-${itemIndex}`, count <= 2 ? 27 : 23, 16);
        if (itemIndex < count - 1) shape('line', palette.line, 1.17, y + rowHeight + gap / 2, 11.27, 0);
      });
    }
  }

  shape('line', palette.line, 0.76, 6.79, 11.8, 0);
  text(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 11.45, y: 6.97, w: 1.1, h: 0.25 }, 'page', 9, 9, { color: palette.muted, align: 'right' });
  return scene;
}

export function diagnoseSlide(slide: Slide, theme: ThemeId = 'ink'): SlideIssue[] {
  return createSlideScene(slide, theme, 0, 1).issues.filter((issue, index, issues) =>
    index === issues.findIndex(other => issue.field === other.field && issue.message === other.message));
}
