// ============================================================
// Minimal PDF writer — text only, Helvetica, A4.
//
// This site has no package.json, so functions cannot pull in a PDF
// library. Everything we need is a single page of laid-out text, which
// is small enough to emit directly.
// ============================================================

const PAGE_W = 595.28;   // A4 points
const PAGE_H = 841.89;
const MARGIN = 42;

// Helvetica advance widths (1/1000 em) for the printable ASCII range.
// Good enough for accurate wrapping without embedding metrics files.
const W = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584
};

const BOLD_FACTOR = 1.06; // Helvetica-Bold runs slightly wider

function charWidth(ch, bold) {
  const w = W[ch] !== undefined ? W[ch] : 556;
  return bold ? w * BOLD_FACTOR : w;
}

function textWidth(str, size, bold) {
  let total = 0;
  for (const ch of String(str)) total += charWidth(ch, bold);
  return (total / 1000) * size;
}

// Replace characters the base WinAnsi font cannot show.
function sanitize(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '-')
    .replace(/\u2713/g, 'Y')
    .replace(/[^\x20-\x7E\n]/g, '');
}

function wrap(str, size, bold, maxWidth) {
  const out = [];
  for (const para of sanitize(str).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (textWidth(test, size, bold) <= maxWidth) { line = test; continue; }
      if (line) out.push(line);
      // A single word longer than the line still has to break somewhere.
      let chunk = word;
      while (textWidth(chunk, size, bold) > maxWidth && chunk.length > 1) {
        let cut = chunk.length;
        while (cut > 1 && textWidth(chunk.slice(0, cut), size, bold) > maxWidth) cut--;
        out.push(chunk.slice(0, cut));
        chunk = chunk.slice(cut);
      }
      line = chunk;
    }
    if (line) out.push(line);
  }
  return out;
}

function escapePdf(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * blocks: [{ text, style }] where style is 'title' | 'heading' | 'label' | 'body' | 'rule' | 'space'
 * Returns a Buffer containing a single-page (or minimally paginated) PDF.
 */
function buildPdf(blocks, opts) {
  const options = opts || {};
  const maxWidth = PAGE_W - MARGIN * 2;

  // Shrink the body size until everything fits on one page, then give up
  // gracefully and allow a second page rather than losing information.
  let size = 9.5, lines = null;
  for (const trial of [9.5, 9, 8.5, 8, 7.5, 7]) {
    size = trial;
    lines = layout(blocks, size, maxWidth);
    if (totalHeight(lines) <= PAGE_H - MARGIN * 2) break;
  }

  const pages = paginate(lines, PAGE_H - MARGIN * 2);
  return emit(pages, options.title || 'Application');
}

function styleOf(style, base) {
  if (style === 'title')   return { size: base + 5.5, bold: true,  lead: base + 10, gapAfter: 4 };
  if (style === 'heading') return { size: base + 0.5, bold: true,  lead: base + 5,  gapAfter: 1.5 };
  if (style === 'label')   return { size: base - 0.5, bold: true,  lead: base + 3,  gapAfter: 0 };
  return { size: base, bold: false, lead: base + 3, gapAfter: 0 };
}

// Left column holds the question, right column the answer.
const COL_GAP = 0;
const LEFT_FRACTION = 0.40;

// Review flags (7 Oct 2026): when any form row carries a flag, every qa row
// gets a narrow third column on the right holding a red flag, an amber
// caution triangle or a green tick, and red/amber rows show the reason under
// the answer. Drawn as vector shapes - the base fonts have no such glyphs.
const FLAG_COL = 24;
const FLAG_FILL = { red: '0.996 0.949 0.949', amber: '1 0.984 0.922' };      // row tint
const FLAG_INK  = { red: '0.725 0.110 0.110', amber: '0.573 0.251 0.055', green: '0.420 0.447 0.502' };

function layout(blocks, base, maxWidth) {
  const out = [];
  const leftW = maxWidth * LEFT_FRACTION;
  const rightW = maxWidth - leftW - COL_GAP;
  const flagCol = blocks.some(b => b.style === 'qa' && b.flag) ? FLAG_COL : 0;

  for (const b of blocks) {
    if (b.style === 'space') { out.push({ kind: 'space', h: b.h || 5 }); continue; }
    if (b.style === 'rule')  { out.push({ kind: 'rule', h: 7 }); continue; }

    if (b.style === 'qa') {
      // One table row: bordered cells, question on a shaded left cell.
      const padX = 5, padY = 3.2;
      const answerW = maxWidth - leftW - flagCol - padX * 2;
      const qLines = wrap(b.question, base - 0.5, true, leftW - padX * 2);
      const aLines = wrap(b.answer || '', base, false, answerW);
      const showReason = b.reason && (b.flag === 'red' || b.flag === 'amber');
      const rLines = showReason ? wrap(b.reason, base - 1, true, answerW) : [];
      const lineH = base + 2.6;
      const rows = Math.max(qLines.length, aLines.length + rLines.length, 1);
      out.push({
        kind: 'row',
        h: rows * lineH + padY * 2,
        qLines, aLines, rLines, lineH, padX, padY,
        leftW, rightW: maxWidth - leftW - flagCol, flagW: flagCol,
        flag: flagCol ? (b.flag || null) : null,
        leftSize: base - 0.5, rightSize: base, reasonSize: base - 1
      });
      continue;
    }

    if (b.style === 'tick') {
      // A checkbox in the left margin with the declaration text beside it.
      const indent = base + 6;
      const lines = wrap(b.text, base, false, maxWidth - indent);
      lines.forEach((t, i) => out.push({
        kind: 'tick', h: base + 3.5, text: t, size: base,
        box: i === 0, checked: !!b.checked, indent
      }));
      continue;
    }

    const st = styleOf(b.style, base);
    const wrapped = wrap(b.text, st.size, st.bold, maxWidth);
    wrapped.forEach(t => out.push({ kind: 'text', text: t, size: st.size, bold: st.bold, h: st.lead }));
    if (st.gapAfter) out.push({ kind: 'space', h: st.gapAfter });
  }
  return out;
}

function totalHeight(lines) {
  return lines.reduce((n, l) => n + l.h, 0);
}

function paginate(lines, usable) {
  const pages = [];
  let page = [], used = 0;
  for (const l of lines) {
    if (used + l.h > usable && page.length) { pages.push(page); page = []; used = 0; }
    page.push(l); used += l.h;
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

function contentStream(lines) {
  let y = PAGE_H - MARGIN;
  const parts = [];
  for (const l of lines) {
    if (l.kind === 'text') {
      y -= l.h;
      parts.push('BT /' + (l.bold ? 'F2' : 'F1') + ' ' + l.size.toFixed(2) + ' Tf ' +
                 '1 0 0 1 ' + MARGIN.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + escapePdf(l.text) + ') Tj ET');
    } else if (l.kind === 'row') {
      const top = y;
      y -= l.h;
      const x0 = MARGIN, x1 = MARGIN + l.leftW, x2 = MARGIN + l.leftW + l.rightW;

      // Shaded descriptor cell
      parts.push('0.945 0.949 0.957 rg ' + x0.toFixed(2) + ' ' + y.toFixed(2) + ' ' +
                 l.leftW.toFixed(2) + ' ' + l.h.toFixed(2) + ' re f 0 0 0 rg');
      // Red / amber rows: tint the answer and flag cells
      if (l.flag && FLAG_FILL[l.flag]) {
        parts.push(FLAG_FILL[l.flag] + ' rg ' + x1.toFixed(2) + ' ' + y.toFixed(2) + ' ' +
                   (l.rightW + l.flagW).toFixed(2) + ' ' + l.h.toFixed(2) + ' re f 0 0 0 rg');
      }
      // Cell borders
      parts.push('0.5 w 0.804 0.827 0.855 RG ' +
                 x0.toFixed(2) + ' ' + y.toFixed(2) + ' ' + l.leftW.toFixed(2) + ' ' + l.h.toFixed(2) + ' re S ' +
                 x1.toFixed(2) + ' ' + y.toFixed(2) + ' ' + l.rightW.toFixed(2) + ' ' + l.h.toFixed(2) + ' re S' +
                 (l.flagW ? ' ' + x2.toFixed(2) + ' ' + y.toFixed(2) + ' ' + l.flagW.toFixed(2) + ' ' + l.h.toFixed(2) + ' re S' : ''));
      if (l.flag) parts.push(flagIcon(l.flag, x2 + l.flagW / 2, top - l.padY - 7));

      let ty = top - l.padY;
      for (let i = 0; i < Math.max(l.qLines.length, l.aLines.length + (l.rLines ? l.rLines.length : 0)); i++) {
        ty -= l.lineH;
        const baseline = ty + l.lineH * 0.24;
        if (l.qLines[i]) {
          parts.push('BT /F2 ' + l.leftSize.toFixed(2) + ' Tf 0.22 0.25 0.29 rg 1 0 0 1 ' +
                     (x0 + l.padX).toFixed(2) + ' ' + baseline.toFixed(2) + ' Tm (' +
                     escapePdf(l.qLines[i]) + ') Tj ET 0 0 0 rg');
        }
        if (l.aLines[i]) {
          parts.push('BT /F1 ' + l.rightSize.toFixed(2) + ' Tf 1 0 0 1 ' +
                     (x1 + l.padX).toFixed(2) + ' ' + baseline.toFixed(2) + ' Tm (' +
                     escapePdf(l.aLines[i]) + ') Tj ET');
        }
        const ri = i - l.aLines.length;
        if (ri >= 0 && l.rLines && l.rLines[ri]) {
          parts.push('BT /F2 ' + l.reasonSize.toFixed(2) + ' Tf ' + (FLAG_INK[l.flag] || '0 0 0') + ' rg 1 0 0 1 ' +
                     (x1 + l.padX).toFixed(2) + ' ' + baseline.toFixed(2) + ' Tm (' +
                     escapePdf(l.rLines[ri]) + ') Tj ET 0 0 0 rg');
        }
      }
    } else if (l.kind === 'tick') {
      y -= l.h;
      if (l.box) {
        const bs = l.size * 0.82;               // box size
        const by = y - 1;
        parts.push('0.7 w 0.35 0.35 0.35 RG ' + MARGIN.toFixed(2) + ' ' + by.toFixed(2) + ' ' +
                   bs.toFixed(2) + ' ' + bs.toFixed(2) + ' re S');
        if (l.checked) {
          const x1 = MARGIN + bs * 0.2, y1 = by + bs * 0.5;
          const x2 = MARGIN + bs * 0.42, y2 = by + bs * 0.22;
          const x3 = MARGIN + bs * 0.82, y3 = by + bs * 0.78;
          parts.push('1.2 w 0.15 0.55 0.15 RG ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' m ' +
                     x2.toFixed(2) + ' ' + y2.toFixed(2) + ' l ' + x3.toFixed(2) + ' ' + y3.toFixed(2) + ' l S');
        }
      }
      parts.push('BT /F1 ' + l.size.toFixed(2) + ' Tf 1 0 0 1 ' + (MARGIN + l.indent).toFixed(2) +
                 ' ' + y.toFixed(2) + ' Tm (' + escapePdf(l.text) + ') Tj ET');
    } else if (l.kind === 'rule') {
      y -= l.h;
      parts.push('0.8 w 0.75 0.75 0.75 RG ' + MARGIN.toFixed(2) + ' ' + (y + 3).toFixed(2) + ' m ' +
                 (PAGE_W - MARGIN).toFixed(2) + ' ' + (y + 3).toFixed(2) + ' l S');
    } else {
      y -= l.h;
    }
  }
  return parts.join('\n');
}

// One icon, centred on (cx, cy), about 11 pt tall.
function flagIcon(flag, cx, cy) {
  const f = n => n.toFixed(2);
  if (flag === 'red') {
    // Pole + red pennant
    return '1 w 0.30 0.30 0.30 RG ' + f(cx - 3.5) + ' ' + f(cy - 5.5) + ' m ' + f(cx - 3.5) + ' ' + f(cy + 5.5) + ' l S ' +
           '0.863 0.149 0.149 rg ' + f(cx - 3) + ' ' + f(cy + 5.5) + ' m ' + f(cx + 5) + ' ' + f(cy + 2.5) + ' l ' +
           f(cx - 3) + ' ' + f(cy - 0.5) + ' l h f 0 0 0 rg';
  }
  if (flag === 'amber') {
    // Amber triangle with a dark "!"
    return '0.961 0.620 0.043 rg ' + f(cx) + ' ' + f(cy + 5.5) + ' m ' + f(cx + 6) + ' ' + f(cy - 5) + ' l ' +
           f(cx - 6) + ' ' + f(cy - 5) + ' l h f ' +
           '0.2 0.2 0.2 rg ' + f(cx - 0.7) + ' ' + f(cy - 1) + ' 1.4 4 re f ' + f(cx - 0.7) + ' ' + f(cy - 3.6) + ' 1.4 1.4 re f 0 0 0 rg';
  }
  // Green tick
  return '1.6 w 1 J 1 j 0.086 0.502 0.239 RG ' + f(cx - 4.5) + ' ' + f(cy) + ' m ' + f(cx - 1.5) + ' ' + f(cy - 3.5) + ' l ' +
         f(cx + 5) + ' ' + f(cy + 4) + ' l S 0 J 0 j';
}

function emit(pages, title) {
  const objects = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [' + pageIds.map(id => id + ' 0 R').join(' ') +
               '] /Count ' + pages.length + ' >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const boldId = 3 + pages.length * 2 + 1;

  pages.forEach((lines, i) => {
    const pid = pageIds[i], cid = pid + 1;
    objects[pid] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W.toFixed(2) + ' ' + PAGE_H.toFixed(2) +
                   '] /Resources << /Font << /F1 3 0 R /F2 ' + boldId + ' 0 R >> >> /Contents ' + cid + ' 0 R >>';
    const stream = contentStream(lines);
    objects[cid] = '<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream';
  });
  objects[boldId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const infoId = boldId + 1;
  objects[infoId] = '<< /Title (' + escapePdf(sanitize(title)) + ') /Producer (Revive Jobs) >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  const count = objects.length;
  pdf += 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let i = 1; i < count; i++) {
    pdf += offsets[i] !== undefined
      ? String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
      : '0000000000 65535 f \n';
  }
  pdf += 'trailer\n<< /Size ' + count + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildPdf };
