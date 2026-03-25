export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .filter((item: any) => "str" in item)
      .map((item: any) => item.str)
      .join(" ");
    texts.push(pageText);
    page.cleanup();
  }
  await doc.destroy();
  return texts.join("\n").trim();
}

export function isImageMimeType(
  contentType: string
): contentType is "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(contentType);
}

export function isPdfMimeType(contentType: string): boolean {
  return contentType === "application/pdf";
}
