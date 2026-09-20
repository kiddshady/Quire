'use strict';
/**
 * Templates HTML para el output PDF (renderizados por Chromium → printToPDF).
 *
 * A diferencia de la UI de la app (cyberpunk oscuro), el PDF es un documento
 * para estudiar/imprimir: blanco, sobrio, con el mismo lenguaje del PDF que
 * generaba Shapeshifter (navy + verde correcta / rojo incorrecta), pero con
 * Unicode completo, imágenes y tipografía real — todo lo que fpdf2 no podía.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a;
         font-size: 10.5pt; line-height: 1.45; margin: 0; }
  h1 { color: #0f3d5e; font-size: 17pt; margin: 0 0 2pt; line-height: 1.25; }
  .sub { color: #5a6b7b; font-size: 9.5pt; margin: 0 0 12pt; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
`;

const QUIZ_CSS = `
  .summary { background: #f7f9fb; border: 1pt solid #e1e6ea; border-radius: 4pt;
             padding: 8pt 12pt; margin-bottom: 10pt; break-inside: avoid; }
  .summary td { padding: 2pt 10pt 2pt 0; font-size: 9.5pt; vertical-align: top; }
  .summary td.k { color: #5a6b7b; min-width: 90pt; white-space: nowrap; }
  .summary tr.grade td.v { color: #1f7a3d; font-weight: 700; font-size: 12pt; }
  .legend { margin: 0 0 14pt; }
  .chip { display: inline-block; font-size: 8.5pt; padding: 2pt 9pt; border-radius: 3pt;
          margin-right: 6pt; border: 1pt solid; }
  .chip.ok  { color: #1f7a3d; background: #eef9f0; border-color: #9fd4ae; }
  .chip.bad { color: #b32525; background: #fdeeee; border-color: #e3a8a8; }
  .q { border: 1pt solid #e1e6ea; border-radius: 4pt; padding: 10pt 12pt;
       margin-bottom: 10pt; break-inside: avoid; }
  .qhead { display: flex; align-items: baseline; gap: 8pt; margin-bottom: 6pt; }
  .qno { color: #0f3d5e; font-weight: 700; font-size: 12pt; white-space: nowrap; }
  .qstate { font-size: 8.5pt; font-weight: 700; padding: 2pt 8pt; border-radius: 3pt; white-space: nowrap; }
  .qstate.ok  { color: #1f7a3d; background: #eef9f0; }
  .qstate.bad { color: #b32525; background: #fdeeee; }
  .qstate.mid { color: #9a6b00; background: #fdf6e3; }
  .qgrade { margin-left: auto; color: #5a6b7b; font-size: 8.5pt; text-align: right; }
  .qtext { font-weight: 600; margin-bottom: 7pt; }
  .qtext p { margin: 0 0 5pt; }
  .opt { padding: 4pt 9pt; border-radius: 3pt; margin-bottom: 2pt; break-inside: avoid; }
  .opt.ok  { background: #eef9f0; }
  .opt.bad { background: #fdeeee; }
  .opt .tag { display: block; font-size: 8pt; font-weight: 700; margin-top: 1pt; }
  .opt .tag.ok  { color: #1f7a3d; }
  .opt .tag.bad { color: #b32525; }
  .match td { border: 1pt solid #e1e6ea; padding: 4pt 9pt; font-size: 9.5pt; }
  .match td.st { width: 55%; }
  .match .mk-ok  { color: #1f7a3d; font-weight: 700; }
  .match .mk-bad { color: #b32525; font-weight: 700; }
  .typed { padding: 4pt 9pt; border-radius: 3pt; display: inline-block; }
  .typed.ok  { background: #eef9f0; color: #1f7a3d; }
  .typed.bad { background: #fdeeee; color: #b32525; }
  .right { background: #f1f8f3; color: #1f7a3d; padding: 6pt 9pt; border-radius: 3pt;
           font-size: 9.5pt; margin-top: 7pt; }
  .right p { margin: 0; }
  .feedback { color: #5a6b7b; font-size: 9pt; margin-top: 7pt;
              border-left: 2pt solid #e1e6ea; padding-left: 9pt; }
  .response { background: #f7f9fb; border: 1pt solid #e1e6ea; border-radius: 3pt;
              padding: 6pt 9pt; font-size: 9.5pt; }
`;

const GENERIC_CSS = `
  h2 { color: #0f3d5e; font-size: 13pt; margin: 14pt 0 5pt; }
  h3 { color: #0f3d5e; font-size: 11.5pt; margin: 11pt 0 4pt; }
  h4 { color: #33536b; font-size: 10.5pt; margin: 9pt 0 3pt; }
  p  { margin: 0 0 7pt; }
  td, th { border: 1pt solid #e1e6ea; padding: 4pt 8pt; font-size: 9.5pt; text-align: left; }
  th { background: #f7f9fb; color: #0f3d5e; }
  table { margin: 0 0 8pt; }
`;

function page(title, css, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

// ---------------- Examen Moodle ----------------

function summaryHtml(summary) {
  const keys = Object.keys(summary);
  if (!keys.length) return '';
  // claves tal como vienen del HTML fuente — Moodle en español o en inglés
  const order = [
    'Estado', 'Status',
    'Comenzado', 'Started on',
    'Completado', 'Completed on',
    'Duración', 'Time taken',
    'Puntos', 'Marks',
    'Calificación', 'Grade',
  ];
  const sorted = [...order.filter((k) => k in summary), ...keys.filter((k) => !order.includes(k))];
  const rows = sorted.map((k) => {
    const cls = /Calificación|Grade/.test(k) ? ' class="grade"' : '';
    return `<tr${cls}><td class="k">${esc(k)}</td><td class="v">${esc(summary[k])}</td></tr>`;
  });
  return `<div class="summary"><table>${rows.join('')}</table></div>`;
}

function optionHtml(o) {
  const chosenWrong = o.checked && !o.correct;
  const cls = o.correct ? ' ok' : chosenWrong ? ' bad' : '';
  let tag = '';
  if (o.correct && o.checked) tag = '<span class="tag ok">✓ Correcta — tu respuesta</span>';
  else if (o.correct) tag = '<span class="tag ok">✓ Correcta</span>';
  else if (chosenWrong) tag = '<span class="tag bad">✗ Tu respuesta (incorrecta)</span>';
  const label = `${o.num ? esc(o.num) + ' ' : ''}${esc(o.text)}`;
  return `<div class="opt${cls}">${label}${tag}</div>`;
}

function matchHtml(pairs) {
  const rows = pairs.map((m) => {
    const mark = m.correct ? '<span class="mk-ok"> ✓</span>' : m.incorrect ? '<span class="mk-bad"> ✗</span>' : '';
    return `<tr><td class="st">${esc(m.stem)}</td><td>${esc(m.answer)}${mark}</td></tr>`;
  });
  return `<table class="match">${rows.join('')}</table>`;
}

function questionHtml(q) {
  const stateCls = q.isPartial ? 'mid' : q.isCorrect ? 'ok' : 'bad';
  const state = q.state || (q.isCorrect ? 'Correcta' : 'Incorrecta');
  const qbody = q.qtextHtml && q.qtextHtml.trim() ? q.qtextHtml : `<p>${esc(q.qtext)}</p>`;

  let answers = '';
  if (q.options && q.options.length) {
    answers = q.options.map(optionHtml).join('');
  } else if (q.matches && q.matches.length) {
    answers = matchHtml(q.matches);
  } else if (q.typed) {
    const cls = q.typed.correct ? 'ok' : q.typed.incorrect ? 'bad' : '';
    const mark = q.typed.correct ? ' ✓' : q.typed.incorrect ? ' ✗' : '';
    answers = `<div class="typed ${cls}">Tu respuesta: <b>${esc(q.typed.value)}</b>${mark}</div>`;
  } else if (q.responseText) {
    answers = `<div class="response">${esc(q.responseText)}</div>`;
  }

  const right = q.rightanswerHtml && q.rightanswerHtml.trim()
    ? `<div class="right">${q.rightanswerHtml}</div>`
    : q.rightanswer ? `<div class="right">${esc(q.rightanswer)}</div>` : '';

  return `<div class="q">
    <div class="qhead">
      <span class="qno">Pregunta ${esc(q.no)}</span>
      <span class="qstate ${stateCls}">${esc(state)}</span>
      ${q.grade ? `<span class="qgrade">${esc(q.grade)}</span>` : ''}
    </div>
    <div class="qtext">${qbody}</div>
    ${answers}
    ${right}
    ${q.feedback ? `<div class="feedback">${esc(q.feedback)}</div>` : ''}
  </div>`;
}

function buildQuizHtml(quiz) {
  const body = `
    <h1>${esc(quiz.title || 'Revisión del intento')}</h1>
    <p class="sub">Revisión del intento — ${quiz.nCorrect}/${quiz.nTotal} respuestas correctas${
      quiz.nPartial ? ` · ${quiz.nPartial} parciales` : ''}</p>
    ${summaryHtml(quiz.summary || {})}
    <div class="legend">
      <span class="chip ok">Respuesta correcta</span>
      <span class="chip bad">Tu respuesta (incorrecta)</span>
    </div>
    ${(quiz.questions || []).map(questionHtml).join('\n')}
  `;
  return page(quiz.title || 'Revisión del intento', QUIZ_CSS, body);
}

// ---------------- Documento genérico ----------------

function genericSection(section, out) {
  if (section.title) {
    const h = Math.min(Math.max(section.level + 1, 2), 4);
    out.push(`<h${h}>${esc(section.title)}</h${h}>`);
  }
  for (const p of section.paragraphs) {
    out.push(`<p>${esc(p).replace(/\n/g, '<br>')}</p>`);
  }
  for (const t of section.tables) {
    const head = t.headers.length
      ? `<tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` : '';
    const rows = t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
    out.push(`<table>${head}${rows}</table>`);
  }
  for (const sub of section.subsections) genericSection(sub, out);
}

function buildGenericHtml(doc) {
  const out = [`<h1>${esc(doc.title)}</h1>`];
  const meta = doc.metadata || {};
  const bits = [];
  if (meta.pages) bits.push(`${meta.pages} pages`);
  if (meta.slides) bits.push(`${meta.slides} slides`);
  if (meta.engine) bits.push(meta.engine);
  if (bits.length) out.push(`<p class="sub">${esc(bits.join(' · '))}</p>`);
  for (const s of doc.sections) genericSection(s, out);
  return page(doc.title, GENERIC_CSS, out.join('\n'));
}

module.exports = { buildQuizHtml, buildGenericHtml };
