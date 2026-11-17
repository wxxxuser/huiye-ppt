import type { PreparedImage } from './types';

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;
export const MAX_IMAGE_EDGE = 1920;
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ImageInfo { mimeType: ImageMime; width: number; height: number }

function dimensions(mimeType: ImageMime, width: number, height: number): ImageInfo {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片尺寸无效或超过 2400 万像素，请缩小后再上传。');
  }
  return { mimeType, width, height };
}

/** Read pixel dimensions before allocating a browser decoder/canvas. SVG is never accepted. */
export function inspectImageBytes(bytes: Uint8Array): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    return dimensions('image/png', view.getUint32(16), view.getUint32(20));
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('JPEG 图片结构损坏。');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        return dimensions('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
    throw new Error('无法读取 JPEG 图片尺寸，请换一张图片。');
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === 'VP8X') {
      const uint24 = (offset: number) => bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
      return dimensions('image/webp', uint24(24) + 1, uint24(27) + 1);
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return dimensions('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return dimensions('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
  }
  throw new Error('无法读取图片。请选择有效的 PNG、JPEG 或 WebP 文件。');
}

export async function inspectImageBlob(blob: Blob): Promise<ImageInfo> {
  if (blob.size === 0 || blob.size > MAX_IMAGE_INPUT_BYTES) throw new Error('图片为空或超过 10 MB，请缩小后上传。');
  return inspectImageBytes(new Uint8Array(await blob.arrayBuffer()));
}

export function safeImageName(value: string, mime: 'image/png' | 'image/jpeg'): string {
  const stem = value.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 100) || '图片';
  return `${stem}.${mime === 'image/png' ? 'png' : 'jpg'}`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片处理失败，请换一张图片。')), type, quality));
}

/** All decoding and compression happens locally; this never calls an AI service. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const info = await inspectImageBlob(file);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('浏览器无法解码这张图片，请换一张 PNG、JPEG 或 WebP。'); }
  const canvas = document.createElement('canvas');
  try {
    dimensions(info.mimeType, bitmap.width, bitmap.height);
    const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * ratio));
    let height = Math.max(1, Math.round(bitmap.height * ratio));
    // Preserve transparency for PNG/WebP; JPEG stays JPEG.
    const mimeType = info.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    for (let attempt = 0; attempt < 9; attempt++) {
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器暂不支持图片处理。');
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of mimeType === 'image/jpeg' ? [0.88, 0.76, 0.64] : [undefined]) {
        const blob = await canvasBlob(canvas, mimeType, quality);
        if (blob.size <= MAX_IMAGE_BYTES) return { blob, width, height, name: safeImageName(file.name, mimeType) };
      }
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
    throw new Error('图片压缩后仍超过 1 MB，请裁剪或缩小后上传。');
  } finally {
    bitmap.close();
    canvas.width = 0; canvas.height = 0;
  }
}

/** Data URLs are transient export inputs, never persisted in the workspace JSON. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size === 0 || blob.size > MAX_IMAGE_BYTES) {
    throw new Error('图片类型或大小不符合导出要求。');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
