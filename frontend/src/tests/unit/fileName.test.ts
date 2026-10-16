import { describe, expect, it } from "vitest";
import { displayFileName, repairMojibake } from "../../lib/fileName";

const asLatin1 = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));

describe("displayFileName", () => {
  it("drops memo and template storage prefixes, also nested ones", () => {
    expect(displayFileName("1712345678901-report.pdf")).toBe("report.pdf");
    expect(displayFileName("1777883043445_0_1769767785008_0_form.doc")).toBe("form.doc");
    expect(displayFileName("2003.doc")).toBe("2003.doc");
  });

  it("repairs Thai names that were stored as UTF-8 bytes read as latin1", () => {
    const broken = asLatin1("ใบลาออก (Resignation Letter).doc");
    expect(broken).not.toContain("ใ");
    expect(displayFileName(`1769767785008_0_${broken}`)).toBe("ใบลาออก (Resignation Letter).doc");
  });

  it("leaves correct and partly destroyed names alone", () => {
    expect(repairMojibake("ใบลาออก.doc")).toBe("ใบลาออก.doc");
    expect(repairMojibake("Café menu.pdf")).toBe("Café menu.pdf");
    // bytes already replaced by "_" cannot be decoded — keep what is there
    const lossy = "à¹_à¸_à¸¥à¸²à¸_.doc";
    expect(repairMojibake(lossy)).toBe(lossy);
  });
});
