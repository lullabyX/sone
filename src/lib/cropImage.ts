const DEFAULT_MAX = 1280;

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampOutputSize(
  area: { width: number; height: number },
  max: number = DEFAULT_MAX,
): number {
  return Math.min(max, Math.round(Math.min(area.width, area.height)));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image for cropping"));
    img.src = src;
  });
}

export async function getCroppedBlob(
  imageSrc: string,
  area: CropArea,
  outputSize: number = clampOutputSize(area),
): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    outputSize,
    outputSize,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("canvas.toBlob failed")),
      "image/jpeg",
      0.9,
    );
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("failed to read blob"));
    reader.readAsDataURL(blob);
  });
}
