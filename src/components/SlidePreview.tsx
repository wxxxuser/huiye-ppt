/// <reference types="vite/client" />
import { createSlideScene, SLIDE_FONT, SLIDE_FONT_LATIN, SLIDE_HEIGHT, SLIDE_WIDTH } from '../presentation';
import type { Slide, ThemeId } from '../types';
import './slide.css';

export interface SlidePreviewProps {
  slide: Slide;
  theme: ThemeId;
  /** Zero-based slide index. */
  index: number;
  total: number;
  compact?: boolean;
  /** Already-loaded local object URLs or encoded data; preview never fetches URLs. */
  images?: Record<string, string>;
}

export function SlidePreview({ slide, theme, index, total, compact = false, images = {} }: SlidePreviewProps) {
  const scene = createSlideScene(slide, theme, index, total);
  const hasOverflow = scene.issues.some(issue => issue.severity === 'error');
  return <div className={`hy-slide-preview${compact ? ' hy-slide-preview--compact' : ''}`}>
    <svg className="hy-slide-canvas" viewBox={`0 0 ${SLIDE_WIDTH * 72} ${SLIDE_HEIGHT * 72}`}
      role="img" aria-label={`第 ${index + 1} 页：${slide.title}`} xmlns="http://www.w3.org/2000/svg">
      <title>{slide.title}</title>
      <rect width="100%" height="100%" fill={scene.background} />
      {scene.elements.map((element, elementIndex) => {
        const key = `${element.kind}-${elementIndex}`;
        if (element.kind === 'shape') {
          if (element.shape === 'line') return <line key={key} x1={element.x * 72} y1={element.y * 72}
            x2={(element.x + element.w) * 72} y2={(element.y + element.h) * 72} stroke={element.color} strokeWidth={0.65} />;
          if (element.shape === 'ellipse') return <ellipse key={key} cx={(element.x + element.w / 2) * 72}
            cy={(element.y + element.h / 2) * 72} rx={element.w * 36} ry={element.h * 36} fill={element.color} />;
          return <rect key={key} x={element.x * 72} y={element.y * 72} width={element.w * 72} height={element.h * 72} fill={element.color} />;
        }
        if (element.kind === 'image') {
          const data = element.assetId ? images[element.assetId] : undefined;
          const source = data && /^(?:blob:|data:image\/(?:png|jpeg);base64,)/.test(data) ? data : undefined;
          return <svg key={key} x={element.x * 72} y={element.y * 72} width={element.w * 72} height={element.h * 72}
            viewBox={`0 0 ${element.w * 72} ${element.h * 72}`} overflow="hidden">
            <rect width="100%" height="100%" fill={element.background}/>
            {source ? <image href={source} width={element.w * 72} height={element.h * 72}
              preserveAspectRatio={`xMidYMid ${element.fit === 'cover' ? 'slice' : 'meet'}`}>
              <title>{element.name || '页面配图'}</title>
            </image> : <text x={element.w * 36} y={element.h * 36} fill={element.color}
              fontFamily={`'${SLIDE_FONT}', sans-serif`} fontSize={16} textAnchor="middle">
              {element.assetId ? '图片加载中或暂不可用' : '上传图片'}
            </text>}
          </svg>;
        }
        const x = (element.x + (element.align === 'center' ? element.w / 2 : element.align === 'right' ? element.w : 0)) * 72;
        return <text key={key} x={x} y={element.y * 72 + element.fontSize * 0.88} fill={element.color}
          fontFamily={`'${SLIDE_FONT_LATIN}', '${SLIDE_FONT}', sans-serif`} fontSize={element.fontSize}
          fontWeight={element.bold ? 700 : 400} textAnchor={element.align === 'right' ? 'end' : element.align === 'center' ? 'middle' : 'start'}
          xmlSpace="preserve">
          {element.lines.map((line, lineIndex) => <tspan key={lineIndex} x={x}
            dy={lineIndex === 0 ? 0 : element.fontSize * element.lineHeight}>{line || '\u00a0'}</tspan>)}
        </text>;
      })}
    </svg>
    {hasOverflow && !compact && <div className="hy-slide-overflow" role="status">内容超出版式，请精简文字或切换版式后导出。原文已完整保留。</div>}
  </div>;
}

export default SlidePreview;
