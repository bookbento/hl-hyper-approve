import { PDFDocument } from "pdf-lib";

/**
 * รวมไฟล์ PDF หลายไฟล์เข้าด้วยกันและแปลงเป็น Base64
 */
export const mergePDFs = async (files: File[]): Promise<string> => {
  const mergedPdf = await PDFDocument.create();

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  const mergedPdfBytes = await mergedPdf.save();
  const base64 = `data:application/pdf;base64,${btoa(String.fromCharCode(...mergedPdfBytes))}`;
  return base64;
};


/**
 * แปลง base64 เป็น Blob URL สำหรับแสดงผล PDF
 */
export const createBlobUrl = (base64: string): string => {
  const byteCharacters = atob(base64);
  const byteArrays = [];

  for (let i = 0; i < byteCharacters.length; i += 1024) {
    const slice = byteCharacters.slice(i, i + 1024);
    const byteNumbers = Array.from(slice).map((char) => char.charCodeAt(0));
    byteArrays.push(new Uint8Array(byteNumbers));
  }

  const blob = new Blob(byteArrays, { type: "application/pdf" });
  return URL.createObjectURL(blob);
};

/**
 * ล้าง Blob URL
 */
export const revokeUrl = (url: string): void => {
  URL.revokeObjectURL(url);
};

/**
 * แปลง Blob เป็น Base64 string
 */
export const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
