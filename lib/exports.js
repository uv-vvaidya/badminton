'use strict';
// Excel (.xlsx) and PDF exports: fixtures (points tables, league and knockout matches) and registrations by event.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const GREEN = 'FF17533F';
const LIGHT = 'FFE8EEE9';

// ---------- shared helpers ----------
const teamName = (teams, id) => {
  const t = id && teams.find((x) => x.id === id);
  return t ? (t.names || []).join(' / ') : 'TBD';
};
const tally = (m) => {
  let a = 0, b = 0;
  for (const g of m.games || []) {
    const hi = Math.max(g[0], g[1]);
    if (!((hi >= m.points && Math.abs(g[0] - g[1]) >= 2) || hi >= m.cap)) continue;
    if (g[0] > g[1]) a++; else b++;
  }
  return [a, b];
};
const scoreText = (m) => (m.games || []).filter((g) => g[0] || g[1]).map((g) => `${g[0]}-${g[1]}`).join(', ');
const statusText = (m) => ({ scheduled: 'Scheduled', live: 'In play', done: 'Final', bye: 'Bye' }[m.status] || m.status);
const fmtTime = (s) => {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const unit = (ek) => (/Doubles/.test(ek) ? 'Team' : 'Player');
const safeSheet = (name, used) => {
  let n = String(name).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31);
  let i = 2;
  while (used.has(n)) n = `${String(name).slice(0, 27)} (${i++})`;
  used.add(n);
  return n;
};

function matchRows(d, ek, stage) {
  return d.matches
    .filter((m) => m.event_key === ek && m.stage === stage)
    .sort((a, b) => (stage === 'knockout' ? (a.round || 99) - (b.round || 99) || a.slot - b.slot : 0) || a.seq - b.seq)
    .map((m) => {
      const [ga, gb] = tally(m);
      return {
        round: stage === 'league' ? `Group ${m.grp}` : m.round_name,
        detail: m.round_name,
        a: m.status === 'bye' && !m.team_a ? 'Bye' : teamName(d.teams, m.team_a),
        b: m.status === 'bye' && !m.team_b ? 'Bye' : teamName(d.teams, m.team_b),
        court: m.court || '',
        time: fmtTime(m.start_time),
        umpire: (m.umpire_id && d.officials[m.umpire_id]) || '',
        status: statusText(m),
        games: m.status === 'done' || m.status === 'live' ? `${ga}-${gb}` : '',
        score: [scoreText(m), m.result_note].filter(Boolean).join(' · '),
        winner: m.winner ? teamName(d.teams, m.winner) : '',
        format: `${m.best_of === 1 ? '1 game' : 'Best of ' + m.best_of} to ${m.points}`,
      };
    });
}

// ---------- Excel ----------
function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
  row.alignment = { vertical: 'middle' };
}
function addTitle(ws, title, sub, span) {
  ws.addRow([title]).font = { bold: true, size: 14 };
  if (sub) ws.addRow([sub]).font = { italic: true, color: { argb: 'FF4F625B' } };
  ws.addRow([]);
  if (span) ws.mergeCells(1, 1, 1, span);
}
function addTable(ws, header, rows, widths) {
  styleHeader(ws.addRow(header));
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    if (i % 2) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
  });
  if (widths) widths.forEach((w, i) => { const col = ws.getColumn(i + 1); col.width = Math.max(col.width || 0, w); });
  ws.addRow([]);
}

async function fixturesXlsx(d, events) {
  const wb = new ExcelJS.Workbook();
  wb.creator = d.settings.name;
  wb.created = new Date();
  const used = new Set();
  for (const ek of events) {
    const ws = wb.addWorksheet(safeSheet(ek, used), { views: [{ state: 'frozen', ySplit: 0 }] });
    const f = d.formats[ek];
    addTitle(ws, `${d.settings.name} · ${ek}`, `League: ${f.league.bestOf === 1 ? '1 game' : 'best of ' + f.league.bestOf} to ${f.league.points} · Knockout: ${f.knockout.bestOf === 1 ? '1 game' : 'best of ' + f.knockout.bestOf} to ${f.knockout.points} · Exported ${fmtDate(new Date())}`, 8);
    const st = d.standings[ek] || {};
    const qs = new Set((d.qualifiers[ek] || []).map((q) => q.team));
    for (const g of Object.keys(st).sort()) {
      ws.addRow([`Group ${g} · Points table`]).font = { bold: true, size: 12 };
      addTable(ws, ['#', unit(ek), 'Played', 'Won', 'Lost', 'Games', 'Point diff', 'Points', 'Knockout'],
        st[g].map((r, i) => [i + 1, teamName(d.teams, r.team), r.p, r.w, r.l, `${r.gw}-${r.gl}`, r.pf - r.pa, r.pts, qs.has(r.team) ? 'Qualifying' : '']),
        [5, 34, 9, 7, 7, 9, 11, 9, 12]);
    }
    const lg = matchRows(d, ek, 'league');
    if (lg.length) {
      ws.addRow(['League matches']).font = { bold: true, size: 12 };
      addTable(ws, ['Group / round', `${unit(ek)} A`, `${unit(ek)} B`, 'Court', 'Start time', 'Umpire', 'Status', 'Games', 'Scores', 'Winner'],
        lg.map((m) => [m.detail || m.round, m.a, m.b, m.court, m.time, m.umpire, m.status, m.games, m.score, m.winner]),
        [20, 30, 30, 8, 22, 16, 11, 8, 26, 30]);
    }
    const ko = matchRows(d, ek, 'knockout');
    if (ko.length) {
      ws.addRow(['Knockout']).font = { bold: true, size: 12 };
      addTable(ws, ['Round', `${unit(ek)} A`, `${unit(ek)} B`, 'Court', 'Start time', 'Umpire', 'Status', 'Games', 'Scores', 'Winner'],
        ko.map((m) => [m.round, m.a, m.b, m.court, m.time, m.umpire, m.status, m.games, m.score, m.winner]));
    }
    if (!Object.keys(st).length && !lg.length && !ko.length) ws.addRow(['No groups or matches yet for this event.']);
  }
  if (!events.length) wb.addWorksheet('Fixtures').addRow(['No events with entries yet.']);
  return wb.xlsx.writeBuffer();
}

function regRows(d, regs, ek) {
  return regs.filter((r) => !ek || r.event_key === ek).map((r, i) => {
    const t = r.team_id && d.teams.find((x) => x.id === r.team_id);
    return {
      n: i + 1, id: r.id, name: `${r.first_name} ${r.last_name}`, category: d.categoryLabels[r.category] || r.category, event: r.event_key,
      mobile: r.mobile, partner: r.event === 'Singles' ? '' : r.has_partner ? r.partner_name : 'Committee to assign', partnerMobile: r.partner_mobile || '',
      status: { pending: 'Awaiting review', approved: 'Confirmed', rejected: 'Rejected' }[r.status] || r.status,
      team: t ? (t.names || []).join(' / ') : '', group: t && t.grp ? t.grp : '',
      due: r.amount_due != null ? r.amount_due : '', registered: fmtDate(r.created_at), about: r.about || '',
    };
  });
}

async function registrationsXlsx(d, regs, events) {
  const wb = new ExcelJS.Workbook();
  wb.creator = d.settings.name;
  const used = new Set();
  // Summary by event
  const sum = wb.addWorksheet(safeSheet('Summary', used));
  addTitle(sum, `${d.settings.name} · Registrations`, `Exported ${fmtDate(new Date())}`, 6);
  addTable(sum, ['Event', 'Total', 'Confirmed', 'Awaiting review', 'Rejected', 'Fees due (Rs)'],
    events.map((ek) => {
      const rs = regs.filter((r) => r.event_key === ek);
      return [ek, rs.length, rs.filter((r) => r.status === 'approved').length, rs.filter((r) => r.status === 'pending').length, rs.filter((r) => r.status === 'rejected').length,
        rs.filter((r) => r.status !== 'rejected').reduce((s, r) => s + (r.amount_due || 0), 0)];
    }), [26, 9, 11, 16, 10, 14]);
  const header = ['#', 'Reg no.', 'Name', 'Category', 'Event', 'Mobile', 'Partner', 'Partner mobile', 'Status', 'Team', 'Group', 'Fee due (Rs)', 'Registered', 'About'];
  const widths = [5, 8, 26, 14, 18, 16, 26, 16, 16, 34, 7, 12, 14, 40];
  const toArr = (x) => [x.n, x.id, x.name, x.category, x.event, x.mobile, x.partner, x.partnerMobile, x.status, x.team, x.group, x.due, x.registered, x.about];
  const all = wb.addWorksheet(safeSheet('All registrations', used));
  addTable(all, header, regRows(d, regs).map(toArr), widths);
  for (const ek of events) {
    const ws = wb.addWorksheet(safeSheet(ek, used));
    addTable(ws, header, regRows(d, regs, ek).map(toArr), widths);
  }
  return wb.xlsx.writeBuffer();
}

// ---------- PDF ----------
function pdfDoc(res, filename, title, landscape) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: title } });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
  doc.pipe(res);
  return doc;
}
function pdfHeading(doc, text, size = 16) {
  doc.moveDown(0.4).font('Helvetica-Bold').fontSize(size).fillColor('#0F221C').text(text, { continued: false });
  doc.moveDown(0.2);
}
// Simple table that wraps cells and breaks across pages, repeating the header.
function pdfTable(doc, header, rows, widths) {
  const x0 = doc.page.margins.left;
  const total = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const sum = widths.reduce((a, b) => a + b, 0);
  const w = widths.map((x) => (x / sum) * total);
  const pad = 4;
  const drawRow = (cells, isHeader, shade) => {
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const h = Math.max(16, ...cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: w[i] - pad * 2 }) + pad * 2));
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      if (!isHeader) { drawRow(header, true); doc.font('Helvetica').fontSize(8.5); }
    }
    const y = doc.y;
    if (isHeader) doc.rect(x0, y, total, h).fill('#17533F');
    else if (shade) doc.rect(x0, y, total, h).fill('#E8EEE9');
    let x = x0;
    cells.forEach((c, i) => {
      doc.fillColor(isHeader ? '#FFFFFF' : '#0F221C').text(String(c ?? ''), x + pad, y + pad, { width: w[i] - pad * 2 });
      x += w[i];
    });
    doc.x = x0; doc.y = y + h;
  };
  drawRow(header, true);
  rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
  doc.moveDown(0.6);
}
function pdfFooter(doc, d) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing below the bottom margin would make PDFKit start a new page, so drop the margin while drawing the footer.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - bottom + 8;
    doc.font('Helvetica').fontSize(7.5).fillColor('#4F625B')
      .text(`${d.settings.name} · Exported ${fmtDate(new Date())} · Page ${i - range.start + 1} of ${range.count}`, doc.page.margins.left, y, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function fixturesPdf(res, d, events, filename) {
  const doc = pdfDoc(res, filename, `${d.settings.name} fixtures`, true);
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#17533F').text(d.settings.name);
  doc.font('Helvetica').fontSize(10).fillColor('#4F625B').text(['Fixtures and points tables', d.settings.dateText, d.settings.venue].filter(Boolean).join(' · '));
  events.forEach((ek, idx) => {
    if (idx > 0) doc.addPage();
    const f = d.formats[ek];
    pdfHeading(doc, ek, 18);
    doc.font('Helvetica').fontSize(9).fillColor('#4F625B').text(`League: ${f.league.bestOf === 1 ? '1 game' : 'best of ' + f.league.bestOf} to ${f.league.points}   ·   Knockout: ${f.knockout.bestOf === 1 ? '1 game' : 'best of ' + f.knockout.bestOf} to ${f.knockout.points}`);
    const st = d.standings[ek] || {};
    const qs = new Set((d.qualifiers[ek] || []).map((q) => q.team));
    for (const g of Object.keys(st).sort()) {
      pdfHeading(doc, `Group ${g} · Points table`, 12);
      pdfTable(doc, ['#', unit(ek), 'P', 'W', 'L', 'Games', '+/-', 'Pts', 'Knockout'],
        st[g].map((r, i) => [i + 1, teamName(d.teams, r.team), r.p, r.w, r.l, `${r.gw}-${r.gl}`, r.pf - r.pa, r.pts, qs.has(r.team) ? 'Qualifying' : '']),
        [3, 30, 4, 4, 4, 6, 5, 5, 9]);
    }
    const lg = matchRows(d, ek, 'league');
    if (lg.length) {
      pdfHeading(doc, 'League matches', 12);
      pdfTable(doc, ['Group / round', `${unit(ek)} A`, `${unit(ek)} B`, 'Court', 'Time', 'Umpire', 'Status', 'Score', 'Winner'],
        lg.map((m) => [m.detail || m.round, m.a, m.b, m.court, m.time, m.umpire, m.status, [m.games, m.score].filter(Boolean).join('  '), m.winner]),
        [11, 19, 19, 5, 13, 10, 9, 12, 17]);
    }
    const ko = matchRows(d, ek, 'knockout');
    if (ko.length) {
      pdfHeading(doc, 'Knockout', 12);
      pdfTable(doc, ['Round', `${unit(ek)} A`, `${unit(ek)} B`, 'Court', 'Time', 'Umpire', 'Status', 'Score', 'Winner'],
        ko.map((m) => [m.round, m.a, m.b, m.court, m.time, m.umpire, m.status, [m.games, m.score].filter(Boolean).join('  '), m.winner]),
        [11, 19, 19, 5, 13, 10, 9, 12, 17]);
    }
    if (!Object.keys(st).length && !lg.length && !ko.length) doc.font('Helvetica').fontSize(10).fillColor('#4F625B').text(`Groups have not been drawn yet. ${d.teams.filter((t) => t.event_key === ek).length} confirmed ${unit(ek).toLowerCase()}${d.teams.filter((t) => t.event_key === ek).length === 1 ? '' : 's'} so far.`);
  });
  if (!events.length) doc.moveDown().font('Helvetica').fontSize(11).text('No events with entries yet.');
  pdfFooter(doc, d);
  doc.end();
}

function registrationsPdf(res, d, regs, events, filename, withContacts) {
  const doc = pdfDoc(res, filename, `${d.settings.name} registrations`, true);
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#17533F').text(d.settings.name);
  doc.font('Helvetica').fontSize(10).fillColor('#4F625B').text(`Registrations by event · ${regs.length} total${withContacts ? ' · Contains phone numbers: committee use only' : ''}`);
  pdfHeading(doc, 'Summary', 12);
  pdfTable(doc, ['Event', 'Total', 'Confirmed', 'Awaiting review', 'Rejected', 'Fees due (Rs)'],
    events.map((ek) => {
      const rs = regs.filter((r) => r.event_key === ek);
      return [ek, rs.length, rs.filter((r) => r.status === 'approved').length, rs.filter((r) => r.status === 'pending').length, rs.filter((r) => r.status === 'rejected').length,
        rs.filter((r) => r.status !== 'rejected').reduce((s, r) => s + (r.amount_due || 0), 0)];
    }), [24, 8, 10, 13, 10, 12]);
  for (const ek of events) {
    const rows = regRows(d, regs, ek);
    if (!rows.length) continue;
    doc.addPage();
    pdfHeading(doc, `${ek} · ${rows.length} registration${rows.length === 1 ? '' : 's'}`, 16);
    const header = withContacts
      ? ['#', 'Reg', 'Name', 'Mobile', 'Partner', 'Partner mobile', 'Status', 'Team', 'Group', 'Fee (Rs)']
      : ['#', 'Name', 'Partner', 'Status', 'Team', 'Group'];
    const widths = withContacts ? [3, 4, 16, 11, 15, 11, 10, 20, 5, 6] : [3, 22, 20, 12, 28, 6];
    pdfTable(doc, header, rows.map((x) => (withContacts
      ? [x.n, x.id, x.name, x.mobile, x.partner, x.partnerMobile, x.status, x.team, x.group, x.due]
      : [x.n, x.name, x.partner, x.status, x.team, x.group])), widths);
  }
  pdfFooter(doc, d);
  doc.end();
}

module.exports = { fixturesXlsx, fixturesPdf, registrationsXlsx, registrationsPdf };
