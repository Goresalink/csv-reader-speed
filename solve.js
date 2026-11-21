// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for {text, header}, only faster.
//
// Strategy: never walk the text one character at a time. Unquoted fields are
// cut with one regex scan for the next comma, LF or CR and a String slice, so
// a plain field costs one scan and one slice and no per-character work.
// Quoted fields find their closing quote with indexOf, skipping "" pairs,
// and slice the whole content at once; only segments that hold a line break
// or a doubled quote pay for extra processing. Stray CRs, quote junk and
// unterminated quotes take slow paths that keep the exact error order of the
// reference.
//
// Semantics (csv-reader 1.0.0): a U+FEFF at the very start is dropped; a
// record ends at LF or CRLF; a line left with no characters is no record; a
// CR outside quotes not followed by LF is dropped (stray_cr); a field opening
// with a quote runs to the next quote that is not doubled, "" inside it is
// one quote, CRLF or a lone CR inside it reads as LF; what follows the
// closing quote up to the next comma or line break is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a literal
// character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal
// character; fields stay strings; columns is the first record when header is
// true else null; rows are padded (short_row) or cut (long_row) to the first
// record's width; each error is {code, line, row} in the order met.
const term = /[,\r\n]/g;
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

function countLF(s) {
  let n = 0;
  let p = -1;
  while ((p = s.indexOf('\n', p + 1)) !== -1) n++;
  return n;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  while (true) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let quoted = false;

    do {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      let prefix = '';
      let uqStart = pos;
      let isJunk = false;

      if (quoted) {
        const open = pos;
        const openLine = line;
        let q = text.indexOf('"', pos + 1);
        let esc = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          esc = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          prefix = '"';
          uqStart = open + 1;
          line = openLine;
        } else {
          const segStart = pos + 1;
          let qval = text.slice(segStart, q);
          const hasCR = qval.indexOf('\r') !== -1;
          if (!esc && !hasCR) {
            line += countLF(qval);
          } else {
            if (esc) qval = qval.replace(/""/g, '"');
            if (hasCR) qval = qval.replace(/\r\n?/g, '\n');
            line += countLF(qval);
          }
          pos = q + 1;
          if (pos >= n) {
            fields.push(qval);
            ended = END;
            continue;
          }
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fields.push(qval);
            ended = COMMA;
            continue;
          }
          if (c === 10) {
            pos += 1;
            line += 1;
            fields.push(qval);
            ended = LINE_BREAK;
            continue;
          }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(qval);
            ended = LINE_BREAK;
            continue;
          }
          prefix = qval;
          uqStart = pos;
          isJunk = true;
        }
      }

      // Unquoted parse onto prefix, from uqStart.
      {
        let seg = prefix === '' ? null : prefix;
        let segStart = uqStart;
        term.lastIndex = uqStart;
        for (;;) {
          const m = term.exec(text);
          let idx = -1;
          let kind = -1;
          if (m !== null) {
            idx = m.index;
            const mc = m[0].charCodeAt(0);
            kind = mc === 44 ? 0 : mc === 10 ? 1 : 2;
          }
          if (idx === -1) {
            pos = n;
            ended = END;
            value = seg === null ? text.slice(segStart) : seg + text.slice(segStart);
            break;
          }
          if (kind === 0) {
            pos = idx + 1;
            ended = COMMA;
            value = seg === null ? text.slice(segStart, idx) : seg + text.slice(segStart, idx);
            break;
          }
          if (kind === 1) {
            pos = idx + 1;
            line += 1;
            ended = LINE_BREAK;
            value = seg === null ? text.slice(segStart, idx) : seg + text.slice(segStart, idx);
            break;
          }
          if (text.charCodeAt(idx + 1) === 10) {
            pos = idx + 2;
            line += 1;
            ended = LINE_BREAK;
            value = seg === null ? text.slice(segStart, idx) : seg + text.slice(segStart, idx);
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          seg = seg === null ? text.slice(segStart, idx) : seg + text.slice(segStart, idx);
          segStart = idx + 1;
        }
      }
      if (isJunk && value.length > prefix.length) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      fields.push(value);
    } while (ended === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
