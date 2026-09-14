/**
 * Bounded capture of the live Cesium viewport for agent/MCP image content.
 *
 * This module deliberately has no dependency on the voice client.  It keeps
 * the browser capture contract reusable by MCP, voice, and future transports.
 */

export const DEFAULT_CAPTURE_MAX_PIXELS = 1200 * 900;
export const DEFAULT_CAPTURE_MAX_ENCODED_BYTES = 200 * 1024;
export const DEFAULT_CAPTURE_QUALITY = 0.74;
export const DEFAULT_CAPTURE_TIMEOUT_MS = 400;

export function computeCaptureSize(
  width,
  height,
  maxPixels = DEFAULT_CAPTURE_MAX_PIXELS,
) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const budget = Math.max(1, Math.floor(Number(maxPixels) || 0));
  if (w * h <= budget) return { width: w, height: h };
  const scale = Math.sqrt(budget / (w * h));
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
  };
}

export function estimateDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const payload = dataUrl.slice(Math.max(0, dataUrl.indexOf(',') + 1));
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function freshFrame(viewer, documentRef, timeoutMs, signal) {
  const scene = viewer?.scene;
  if (!scene || documentRef?.hidden || signal?.aborted)
    return Promise.resolve(false);
  if (!scene.postRender?.addEventListener) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let remove = () => {};
    let timer = null;
    const abort = () => finish(false);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      remove();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      resolve(value && !documentRef?.hidden);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    remove = scene.postRender.addEventListener(() => finish(true)) || remove;
    signal?.addEventListener?.('abort', abort, { once: true });
    scene.requestRender?.();
  });
}

/**
 * Capture the current Cesium canvas.
 *
 * Returns an object containing MCP-compatible image content plus provenance,
 * or null when no safe current frame can be produced.
 */
export async function captureCesiumViewport({
  viewer,
  source,
  documentRef = globalThis.document,
  maxPixels = DEFAULT_CAPTURE_MAX_PIXELS,
  maxEncodedBytes = DEFAULT_CAPTURE_MAX_ENCODED_BYTES,
  format = 'jpeg',
  quality = DEFAULT_CAPTURE_QUALITY,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  requireFresh = true,
  signal,
  timestamp = Date.now,
} = {}) {
  const canvas =
    source ||
    viewer?.scene?.canvas ||
    documentRef?.querySelector?.('#cesiumContainer .cesium-widget canvas');
  if (
    !canvas?.width ||
    !canvas?.height ||
    !documentRef?.createElement ||
    signal?.aborted
  )
    return null;
  const fresh = requireFresh
    ? await freshFrame(viewer, documentRef, timeoutMs, signal)
    : false;
  if (requireFresh && !fresh) return null;
  if (signal?.aborted) return null;
  const size = computeCaptureSize(canvas.width, canvas.height, maxPixels);
  const target = documentRef.createElement('canvas');
  target.width = size.width;
  target.height = size.height;
  const context = target.getContext?.('2d');
  if (!context) return null;
  const mimeType = format === 'png'
    ? 'image/png'
    : format === 'webp'
      ? 'image/webp'
      : 'image/jpeg';
  let dataUrl;
  try {
    context.drawImage(canvas, 0, 0, size.width, size.height);
    dataUrl = target.toDataURL(
      mimeType,
      mimeType === 'image/jpeg' || mimeType === 'image/webp'
        ? quality
        : undefined,
    );
  } catch {
    return null;
  }
  const encodedBytes = estimateDataUrlBytes(dataUrl);
  if (
    !dataUrl.startsWith(`data:${mimeType};base64,`) ||
    encodedBytes > maxEncodedBytes
  )
    return null;
  const comma = dataUrl.indexOf(',');
  const tilesLoaded =
    viewer?.scene?.globe?.tilesLoaded ?? viewer?.scene?.tilesLoaded ?? null;
  const capturedAt = typeof timestamp === 'function' ? timestamp() : timestamp;
  return {
    type: 'image',
    data: dataUrl.slice(comma + 1),
    mimeType,
    width: size.width,
    height: size.height,
    timestamp: capturedAt,
    tileSettled: tilesLoaded === null ? null : Boolean(tilesLoaded),
    freshFrame: Boolean(fresh),
    encodedBytes,
  };
}
