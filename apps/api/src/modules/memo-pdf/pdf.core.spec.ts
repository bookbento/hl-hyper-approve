import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, degrees } from 'pdf-lib';
import { flattenPageRotation } from './pdf.core';

/** a page whose /Contents is a reference to an array of streams, as WPS writes it */
async function wpsStylePage(rotate: number, box = [0, 0, 841.85, 595.25]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([box[2] - box[0], box[3] - box[1]]);
  page.setMediaBox(box[0], box[1], box[2] - box[0], box[3] - box[1]);
  const s1 = doc.context.register(doc.context.stream('q 0 0 1 rg 10 10 50 50 re f Q\n'));
  const s2 = doc.context.register(doc.context.stream('q 1 0 0 rg 100 100 50 50 re f Q\n'));
  const arrRef = doc.context.register(doc.context.obj([s1, s2]));
  page.node.set(PDFName.of('Contents'), arrRef);
  page.setRotation(degrees(rotate));
  return { doc, page, s1, s2 };
}

const contentsOf = (doc: PDFDocument, page: ReturnType<PDFDocument['getPage']>) =>
  doc.context.lookup(page.node.get(PDFName.of('Contents'))) as PDFArray;

const text = (doc: PDFDocument, ref: unknown) =>
  Buffer.from((doc.context.lookup(ref as PDFRef) as PDFRawStream).getContents()).toString('latin1');

describe('flattenPageRotation', () => {
  it('splices the streams of an indirect /Contents array (WPS) instead of nesting it', async () => {
    const { doc, page, s1, s2 } = await wpsStylePage(270);
    flattenPageRotation(page, doc);

    const items = contentsOf(doc, page).asArray();
    // [q+cm, s1, s2, Q]: every entry is a stream ref, none is an array
    expect(items).toHaveLength(4);
    expect(items[1]).toBe(s1);
    expect(items[2]).toBe(s2);
    for (const it of items) expect(doc.context.lookup(it)).toBeInstanceOf(PDFRawStream);
    expect(text(doc, items[0])).toContain('q 0 1 -1 0 595.25 0 cm');
    expect(text(doc, items[3])).toBe('Q\n');

    expect(page.getRotation().angle).toBe(0);
    const mb = page.getMediaBox();
    expect([mb.width, mb.height]).toEqual([595.25, 841.85]);
  });

  it('normalizes negative angles (-90 is 270)', async () => {
    const { doc, page } = await wpsStylePage(-90);
    flattenPageRotation(page, doc);
    expect(page.getRotation().angle).toBe(0);
    expect(page.getMediaBox().width).toBeCloseTo(595.25);
  });

  it('moves a non-zero box origin to 0,0 before rotating', async () => {
    const { doc, page } = await wpsStylePage(90, [20, 30, 620, 830]);
    flattenPageRotation(page, doc);
    const items = contentsOf(doc, page).asArray();
    expect(text(doc, items[0])).toContain('1 0 0 1 -20 -30 cm');
    const mb = page.getMediaBox();
    expect([mb.x, mb.y, mb.width, mb.height]).toEqual([0, 0, 800, 600]);
  });

  it('leaves unrotated pages alone', async () => {
    const { doc, page } = await wpsStylePage(0);
    const before = page.node.get(PDFName.of('Contents'));
    flattenPageRotation(page, doc);
    expect(page.node.get(PDFName.of('Contents'))).toBe(before);
  });
});
