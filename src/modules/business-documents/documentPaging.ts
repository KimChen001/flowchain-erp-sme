// The printed page of a business document (a PO, a customer invoice): A4 with
// 12 mm margins, and each page numbered at its foot from the browser's page
// counters, "Page 2 of 3", in the language the document prints in, as the
// receive sheet does (design audit L11-17). The number sits in an @page
// margin box; browsers without margin boxes (Firefox, Safari) print no number
// rather than a wrong one. The document itself already flows across pages
// (business-documents.css).

// [English, Chinese].
const PAGE_NUMBER_CONTENT = [
  '"Page " counter(page) " of " counter(pages)',
  '"第 " counter(page) " 页 / 共 " counter(pages) " 页"',
] as const;

export function documentPageRule(language: string) {
  const content = PAGE_NUMBER_CONTENT[language === "zh-CN" ? 1 : 0];
  return `@media print { @page { size: A4; margin: 12mm; @bottom-right { content: ${content}; font-family: sans-serif; font-size: 9pt; color: #4b5563; } } }`;
}
