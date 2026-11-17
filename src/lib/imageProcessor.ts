export type ImageFilterMode = 'none' | 'grayscale' | 'high-contrast' | 'invert';

export interface ImageProcessOptions {
  rotateDeg: 0 | 90 | 180 | 270;
  flipH: boolean;
  filter: ImageFilterMode;
  maxDimension: 0 | 1280 | 800;
  outputMime: 'image/jpeg' | 'image/png' | 'image/webp';
  quality?: number;
}

export interface ProcessedImageResult {
  base64: string;
  mimeType: string;
  dataUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image for processing.'));
    img.src = src;
  });
}

export async function processImageAttachment(
  base64Data: string,
  sourceMimeType: string,
  options: ImageProcessOptions
): Promise<ProcessedImageResult> {
  const srcUrl = `data:${sourceMimeType};base64,${base64Data}`;
  const img = await loadImage(srcUrl);

  const isRotatedOdd = options.rotateDeg === 90 || options.rotateDeg === 270;
  const rawW = isRotatedOdd ? img.naturalHeight : img.naturalWidth;
  const rawH = isRotatedOdd ? img.naturalWidth : img.naturalHeight;

  let targetW = rawW;
  let targetH = rawH;
  if (options.maxDimension > 0 && Math.max(rawW, rawH) > options.maxDimension) {
    const scale = options.maxDimension / Math.max(rawW, rawH);
    targetW = Math.max(1, Math.round(rawW * scale));
    targetH = Math.max(1, Math.round(rawH * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable in this browser.');
  }

  ctx.save();
  if (options.outputMime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
  }

  if (options.filter === 'grayscale') {
    ctx.filter = 'grayscale(100%)';
  } else if (options.filter === 'high-contrast') {
    ctx.filter = 'grayscale(100%) contrast(175%) brightness(108%)';
  } else if (options.filter === 'invert') {
    ctx.filter = 'invert(100%)';
  } else {
    ctx.filter = 'none';
  }

  ctx.translate(targetW / 2, targetH / 2);
  if (options.rotateDeg !== 0) {
    ctx.rotate((options.rotateDeg * Math.PI) / 180);
  }
  if (options.flipH) {
    ctx.scale(-1, 1);
  }

  const drawW = isRotatedOdd ? targetH : targetW;
  const drawH = isRotatedOdd ? targetW : targetH;
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  const quality = options.outputMime === 'image/png' ? undefined : options.quality ?? 0.88;
  const dataUrl = canvas.toDataURL(options.outputMime, quality);
  const commaIdx = dataUrl.indexOf(',');
  const outBase64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : '';
  const sizeBytes = Math.ceil((outBase64.length * 3) / 4);

  return {
    base64: outBase64,
    mimeType: options.outputMime,
    dataUrl,
    width: targetW,
    height: targetH,
    sizeBytes,
  };
}
