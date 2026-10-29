/**
 * An image as encodeImage made it.
 */
export interface EncodedImage {
  data: ArrayBuffer;
  width: number;
  height: number;
}

/**
 * Decodes an image, scales it down so that its longest side is at most
 * maxSide, and encodes it as JPEG.
 *
 * Browsers apply the orientation cameras record, so the result is upright.
 * Transparent areas become white. The result carries no metadata, so no
 * location either.
 *
 * @param data The image file
 * @param type Its media type, e.g. "image/png"
 * @param maxSide Longest side of the result, in pixels
 * @param quality JPEG quality, 1 to 100
 * @returns null if the image can't be decoded or encoded here
 */
export async function encodeImage(
  data: ArrayBuffer,
  type: string,
  maxSide: number,
  quality: number,
): Promise<EncodedImage | null> {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image can't be decoded"));
      image.src = url;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width === 0 || height === 0) {
      return null;
    }
    const scale = Math.min(1, maxSide / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (context === null) {
      return null;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality / 100),
    );
    if (blob === null || blob.type !== "image/jpeg") {
      // The canvas was too large for this device, or the encoding failed;
      // a browser without JPEG would give PNG
      return null;
    }
    return {
      data: await blob.arrayBuffer(),
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
    // iOS frees a canvas's memory only when it's emptied, and refuses new
    // canvases past a total
    canvas.width = 0;
    canvas.height = 0;
  }
}
