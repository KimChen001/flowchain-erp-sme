import type { PrintLayoutElement, PrintPageConfig } from "./printLayoutTypes";

// How a sheet longer than one page prints (design audit L11-17). On screen the
// editor shows one page with every element where it was placed. In print the
// lines table grows to hold every line, what is below it moves down with it,
// and the browser pages the result: print-layout.css lays the sheet out in the
// bands below, repeats the table's header row on each page and keeps each
// line on one page. No PDF library is involved.

export type PrintBandId = "above" | "table" | "below";
export type PrintBand = { id: PrintBandId; offset: number; height: number; elements: PrintLayoutElement[] };

const extent = (elements: PrintLayoutElement[], offset: number) => Math.max(0, ...elements.map((element) => element.y + element.height - offset));

// The sheet's elements in three bands: those that start above the lines
// table, the table with anything that starts beside it, and those that start
// below it. In print each band is a block of its own height, its elements
// placed from the band's top (offset), so the band below starts where the
// table ends. Without a table the sheet is one band, as on screen.
export function printBands(elements: PrintLayoutElement[]): PrintBand[] {
  const table = elements.filter((element) => element.type === "table").sort((a, b) => a.y - b.y)[0];
  if (!table) return [{ id: "above", offset: 0, height: extent(elements, 0), elements }];
  const top = table.y;
  const bottom = table.y + table.height;
  const rest = elements.filter((element) => element !== table);
  const beside = rest.filter((element) => element.y >= top && element.y < bottom);
  const below = rest.filter((element) => element.y >= bottom);
  return [
    { id: "above", offset: 0, height: top, elements: rest.filter((element) => element.y < top) },
    { id: "table", offset: top, height: Math.max(table.height, extent(beside, top)), elements: [table, ...beside] },
    { id: "below", offset: bottom, height: extent(below, bottom), elements: below },
  ];
}

// The page number the browser prints at the foot of each page, from its page
// counters, in the interface language: [English, Chinese].
const PAGE_NUMBER_CONTENT = [
  '"Page " counter(page) " of " counter(pages)',
  '"第 " counter(page) " 页 / 共 " counter(pages) " 页"',
] as const;

// The print page rule: the sheet's paper and orientation, no side margins
// (the sheet keeps its own), no top margin on the first page (the sheet's own
// top margin is there) and 10 mm on the pages after it, where the repeated
// header row starts. With a page number on the sheet, the number is printed in
// the 10 mm at the foot of every page through an @page margin box, in the
// browsers that support them (Chrome and Edge); the others print none rather
// than a wrong one.
export function printPageRule(page: Pick<PrintPageConfig, "orientation" | "margin">, pageNumber: boolean, language: string) {
  const content = PAGE_NUMBER_CONTENT[language === "en-US" ? 0 : 1];
  const number = pageNumber ? ` @page { @bottom-right { content: ${content}; padding-right: ${page.margin}px; font-size: 10px; color: #111; } }` : "";
  return `@media print { @page { size: A4 ${page.orientation}; margin: 10mm 0; } @page :first { margin-top: 0; }${number} }`;
}
