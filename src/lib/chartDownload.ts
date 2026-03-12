function sanitizeFilename(value: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "chart";
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function svgDimensions(svg: SVGSVGElement) {
  const viewBox = svg.viewBox?.baseVal;
  const widthAttr = Number(svg.getAttribute("width") || "");
  const heightAttr = Number(svg.getAttribute("height") || "");
  const width = (viewBox?.width && Number.isFinite(viewBox.width) ? viewBox.width : 0) || widthAttr || svg.clientWidth || 1200;
  const height = (viewBox?.height && Number.isFinite(viewBox.height) ? viewBox.height : 0) || heightAttr || svg.clientHeight || 700;
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function downloadSvgAsPng(svg: SVGSVGElement, filenamePrefix: string) {
  const { width, height } = svgDimensions(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  const serialized = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to render chart image"));
      img.src = svgUrl;
    });

    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to initialize image canvas");

    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Unable to create PNG file"));
          return;
        }
        resolve(blob);
      }, "image/png");
    });

    triggerDownload(`${sanitizeFilename(filenamePrefix)}-${timestamp()}.png`, pngBlob);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
