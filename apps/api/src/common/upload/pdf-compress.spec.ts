import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PDFDocument, degrees } from 'pdf-lib';
import {
  MIN_BYTES,
  __resetGsMissing,
  compressPdfInPlace,
  compressUploadedPdfs,
  sameGeometry,
} from './pdf-compress';

/** a PDF padded past MIN_BYTES with an unused stream, so "compression" has room */
async function bigPdf(pages: Array<[number, number, number]>, pad = MIN_BYTES + 50_000): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h, rot] of pages) doc.addPage([w, h]).setRotation(degrees(rot));
  doc.context.register(doc.context.stream('%'.repeat(pad)));
  return doc.save({ useObjectStreams: false });
}

async function smallPdf(pages: Array<[number, number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h, rot] of pages) doc.addPage([w, h]).setRotation(degrees(rot));
  return doc.save();
}

describe('pdf-compress', () => {
  let dir: string;
  const write = (name: string, bytes: Uint8Array) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  };
  /** fake gs that writes the given bytes as its output */
  const gsWriting = (bytes: Uint8Array) =>
    jest.fn(async (_in: string, out: string) => {
      fs.writeFileSync(out, bytes);
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfc-'));
    delete process.env.PDF_COMPRESS;
    __resetGsMissing();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const A4: [number, number, number] = [595, 842, 0];
  const LAND270: [number, number, number] = [842, 595, 270];

  it('replaces the file when the result is smaller with the same pages', async () => {
    const p = write('scan.pdf', await bigPdf([A4, LAND270]));
    const out = await smallPdf([A4, LAND270]);
    const r = await compressPdfInPlace(p, { gs: gsWriting(out) });
    expect(r).toEqual({ compressed: true, size: out.length });
    expect(fs.statSync(p).size).toBe(out.length);
    expect(fs.readdirSync(dir)).toEqual(['scan.pdf']); // no temp file left
  });

  it('keeps the original when a page changes size or rotation', async () => {
    const original = await bigPdf([A4, LAND270]);
    const p = write('scan.pdf', original);
    const r = await compressPdfInPlace(p, { gs: gsWriting(await smallPdf([A4, [842, 595, 0]])) });
    expect(r.reason).toBe('geometry');
    expect(fs.readFileSync(p).equals(Buffer.from(original))).toBe(true);
  });

  it('keeps the original when the page count changes', async () => {
    const p = write('scan.pdf', await bigPdf([A4, A4]));
    const r = await compressPdfInPlace(p, { gs: gsWriting(await smallPdf([A4])) });
    expect(r.compressed).toBe(false);
  });

  it('keeps the original when the saving is under 10%', async () => {
    const original = await bigPdf([A4]);
    const p = write('scan.pdf', original);
    const almost = await bigPdf([A4], MIN_BYTES + 45_000);
    const r = await compressPdfInPlace(p, { gs: gsWriting(almost) });
    expect(r.reason).toBe('not-smaller');
    expect(fs.statSync(p).size).toBe(original.length);
  });

  it('skips small files, digitally signed files, and PDF_COMPRESS=off without running gs', async () => {
    const gs = jest.fn();
    expect((await compressPdfInPlace(write('s.pdf', await smallPdf([A4])), { gs })).reason).toBe('small');

    const signed = Buffer.concat([Buffer.from(await bigPdf([A4])), Buffer.from('\n% /ByteRange [0 1 2 3]\n')]);
    expect((await compressPdfInPlace(write('sig.pdf', signed), { gs })).reason).toBe('signed');

    process.env.PDF_COMPRESS = 'off';
    expect((await compressPdfInPlace(write('b.pdf', await bigPdf([A4])), { gs })).reason).toBe('disabled');
    expect(gs).not.toHaveBeenCalled();
  });

  it('keeps the original and cleans up when gs fails', async () => {
    const original = await bigPdf([A4]);
    const p = write('scan.pdf', original);
    const gs = jest.fn(async (_i: string, out: string) => {
      fs.writeFileSync(out, 'partial');
      throw new Error('gs crashed');
    });
    const r = await compressPdfInPlace(p, { gs });
    expect(r.reason).toBe('error');
    expect(fs.readdirSync(dir)).toEqual(['scan.pdf']);
    expect(fs.statSync(p).size).toBe(original.length);
  });

  it('turns itself off when the gs binary is missing', async () => {
    const p = write('scan.pdf', await bigPdf([A4]));
    const missing = Object.assign(new Error('spawn gs ENOENT'), { code: 'ENOENT', syscall: 'spawn gs' });
    const gs = jest.fn(async () => {
      throw missing;
    });
    expect((await compressPdfInPlace(p, { gs })).reason).toBe('no-gs');
    expect((await compressPdfInPlace(p, { gs })).reason).toBe('no-gs');
    expect(gs).toHaveBeenCalledTimes(1);
  });

  it('sameGeometry compares visual size, so a 270° landscape equals a portrait box', () => {
    const portrait = { n: 1, pages: [{ rot: 0, w: 595, h: 842 }] };
    const rotated = { n: 1, pages: [{ rot: 90, w: 842, h: 595 }] };
    expect(sameGeometry(portrait, rotated)).toBe(true);
    expect(sameGeometry(portrait, { n: 1, pages: [{ rot: 0, w: 842, h: 595 }] })).toBe(false);
  });

  it('compressUploadedPdfs only looks at PDFs and skips small ones without reading them', async () => {
    const files = [
      { path: path.join(dir, 'nope.docx'), originalname: 'a.docx', mimetype: 'application/msword', size: 10 },
      { path: path.join(dir, 'missing.pdf'), originalname: 'b.pdf', mimetype: 'application/pdf', size: 100 },
    ] as Express.Multer.File[];
    await expect(compressUploadedPdfs(files)).resolves.toBeUndefined();
    expect(files[1].size).toBe(100);
  });
});
