// pdf.js worker for react-pdf. Import this module (for its side effect) from every
// file that renders or parses PDFs. It used to be set from dashboard.tsx, which only
// worked because every page was bundled and evaluated at startup.
import { pdfjs } from "react-pdf";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
