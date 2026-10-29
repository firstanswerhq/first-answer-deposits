// A tiny text-only PDF writer (Helvetica, letter size, wrapped lines, as many pages as needed). Enough for the
// dispute evidence file PayPal accepts (it takes PDF, JPG, GIF or PNG, not plain text). No dependencies.
const W = 612;
const H = 792;
const MARGIN = 54;
const SIZE = 10;
const LEAD = 14;
const PER_PAGE = Math.floor((H - 2 * MARGIN) / LEAD);
const MAX_CHARS = 98;

// PDF strings: Latin-1 only, with ( ) \ escaped. Anything outside Latin-1 becomes "?".
const esc = (s) =>
  String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/[\\()]/g, (c) => `\\${c}`);

function wrap(line) {
  const out = [];
  let rest = String(line);
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(' ', MAX_CHARS);
    if (cut < 20) cut = MAX_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

// lines: array of strings; a line starting with "# " is drawn bold as a heading.
export function textPdf(lines, { title = 'Document' } = {}) {
  const flat = lines.flatMap((l) => (String(l).startsWith('# ') ? [{ bold: true, text: String(l).slice(2) }] : wrap(l).map((text) => ({ bold: false, text }))));
  const pages = [];
  for (let i = 0; i < flat.length; i += PER_PAGE) pages.push(flat.slice(i, i + PER_PAGE));
  if (!pages.length) pages.push([]);

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${esc(title)}) /Producer (First Answer) >>`);
  const kids = [];
  for (const page of pages) {
    const ops = ['BT', `${MARGIN} ${H - MARGIN} Td`, `${LEAD} TL`];
    for (const l of page) ops.push(`/${l.bold ? 'F2' : 'F1'} ${l.bold ? SIZE + 1 : SIZE} Tf (${esc(l.text)}) Tj T*`);
    ops.push('ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
