'use strict';
/**
 * Converter: "Revisión del intento" de cuestionarios Moodle (.htm/.html).
 *
 * Port mejorado del MoodleQuizConverter de Shapeshifter:
 *  - Soporta multichoice, truefalse, match, shortanswer/numerical y un
 *    fallback genérico para tipos desconocidos (antes: solo MC y V/F).
 *  - Detecta "parcialmente correcta" además de correcta/incorrecta.
 *  - Conserva el HTML sanitizado del enunciado (con imágenes inlineadas como
 *    data URLs desde la carpeta `_files` que guarda el navegador) para que el
 *    output PDF las renderice — fpdf2 las ignoraba por completo.
 *  - Si el .htm no es un quiz de Moodle, NO revienta: el registry cae al
 *    converter HTML genérico (detect() devuelve false).
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { makeDocument, makeSection } = require('../document.cjs');
const { decodeText } = require('../encoding.cjs');

const KEEP_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'pre', 'code', 'blockquote',
]);

const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const IMG_MAX_BYTES = 10 * 1024 * 1024;

function collapse(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function textOf($el) {
  return $el && $el.length ? collapse($el.text()) : '';
}

/** Imagen relativa al .htm (carpeta `_files`) → data URL. null si no se puede. */
function inlineImage(src, baseDir) {
  if (!src) return null;
  if (src.startsWith('data:')) return src.length < IMG_MAX_BYTES ? src : null;
  if (/^[a-z]+:\/\//i.test(src)) return null; // remotas: no tocamos la red
  if (!baseDir) return null;
  try {
    const abs = path.resolve(baseDir, decodeURIComponent(src));
    if (!abs.startsWith(path.resolve(baseDir))) return null;
    const mime = IMG_MIME[path.extname(abs).toLowerCase()];
    if (!mime) return null;
    const stat = fs.statSync(abs);
    if (stat.size > IMG_MAX_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Sanitiza el subárbol: whitelist de tags, sin atributos (salvo img src/alt y
 * col/rowspan), imágenes inlineadas. Devuelve el innerHTML limpio.
 */
function sanitizedHtml($, $root, baseDir) {
  if (!$root || !$root.length) return '';
  const $copy = cheerio.load(`<div id="__omni_root">${$.html($root)}</div>`, null, false);
  const root = $copy('#__omni_root');
  root.find('script, style, link, iframe, object, embed, button, input, select, textarea, noscript').remove();

  // Hojas antes que padres, así unwrappear un padre no pierde hijos ya limpios.
  const all = root.find('*').get().reverse();
  for (const el of all) {
    const $el = $copy(el);
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'img') {
      const data = inlineImage($el.attr('src'), baseDir);
      const alt = $el.attr('alt') || '';
      const width = $el.attr('width');
      const height = $el.attr('height');
      el.attribs = {};
      if (data) {
        $el.attr('src', data);
        if (alt) $el.attr('alt', alt);
        if (width) $el.attr('width', width);
        if (height) $el.attr('height', height);
      } else {
        $el.replaceWith(alt ? `[imagen: ${alt}]` : '');
      }
      continue;
    }
    if (!KEEP_TAGS.has(tag)) {
      $el.replaceWith($el.contents());
      continue;
    }
    const keep = tag === 'td' || tag === 'th' ? ['colspan', 'rowspan'] : [];
    for (const attr of Object.keys(el.attribs || {})) {
      if (!keep.includes(attr)) $el.removeAttr(attr);
    }
  }
  return (root.html() || '').trim();
}

function qtypeOf(classes) {
  const known = ['multichoice', 'truefalse', 'match', 'shortanswer', 'numerical', 'essay', 'multianswer', 'calculated', 'ddwtos', 'gapselect'];
  return known.find((k) => classes.includes(k)) || 'unknown';
}

function extractOptions($, $q) {
  const options = [];
  $q.find('div.answer > div').each((_, row) => {
    const $row = $(row);
    const classes = ($row.attr('class') || '').split(/\s+/);
    const $inp = $row.find('input').first();
    const $num = $row.find('span.answernumber').first();
    // multichoice: texto en div.flex-fill — truefalse: en <label>.
    let $body = $row.find('div.flex-fill').first();
    if (!$body.length) $body = $row.find('label').first();
    let text = textOf($body);
    const num = textOf($num);
    if (num && text.startsWith(num)) text = text.slice(num.length).trim();
    options.push({
      num,
      text,
      checked: $inp.length ? $inp.attr('checked') !== undefined : false,
      correct: classes.includes('correct'),
      incorrect: classes.includes('incorrect'),
    });
  });
  return options;
}

/** Preguntas de emparejamiento: tabla .answer con select por fila. */
function extractMatches($, $q) {
  const pairs = [];
  $q.find('table.answer tr').each((_, tr) => {
    const $tr = $(tr);
    const stem = textOf($tr.find('td.text').first());
    if (!stem) return;
    const $sel = $tr.find('select').first();
    let answer = '';
    if ($sel.length) {
      // Sin [selected] no sabemos qué eligió: la primera <option> es el
      // "Elegir..." del placeholder, y darla por respuesta es inventar un dato.
      answer = textOf($sel.find('option[selected]').first());
    } else {
      answer = textOf($tr.find('td.control').first());
    }
    const trClasses = ($tr.attr('class') || '').split(/\s+/);
    const cellClasses = ($tr.find('td.control').attr('class') || '').split(/\s+/);
    pairs.push({
      stem,
      answer,
      correct: trClasses.includes('correct') || cellClasses.includes('correct'),
      incorrect: trClasses.includes('incorrect') || cellClasses.includes('incorrect'),
    });
  });
  return pairs;
}

/** Respuesta tipeada (shortanswer/numerical): input con value + clase correct/incorrect. */
function extractTyped($, $q) {
  const $inp = $q.find('div.answer input, .ablock input').first();
  if (!$inp.length) return null;
  const classes = ($inp.attr('class') || '').split(/\s+/);
  return {
    value: $inp.attr('value') || '',
    correct: classes.includes('correct'),
    incorrect: classes.includes('incorrect'),
  };
}

function extractQuestions($, baseDir) {
  const questions = [];
  $('div.que').each((_, q) => {
    const $q = $(q);
    const classes = ($q.attr('class') || '').split(/\s+/);
    const type = qtypeOf(classes);
    const state = textOf($q.find('div.state').first());
    const isCorrect = classes.includes('correct') && !classes.includes('incorrect');
    const isPartial = classes.includes('partiallycorrect') || /parcial/i.test(state);

    const $qtext = $q.find('div.qtext').first();
    const question = {
      no: textOf($q.find('span.qno').first()) || '?',
      type,
      state,
      grade: textOf($q.find('div.grade').first()),
      isCorrect,
      isPartial,
      qtext: textOf($qtext),
      qtextHtml: sanitizedHtml($, $qtext, baseDir),
      options: [],
      matches: [],
      typed: null,
      responseText: '',
      rightanswer: textOf($q.find('div.rightanswer').first()),
      rightanswerHtml: sanitizedHtml($, $q.find('div.rightanswer').first(), baseDir),
      feedback: textOf($q.find('div.generalfeedback').first()),
    };

    if (type === 'match') {
      question.matches = extractMatches($, $q);
    } else if (type === 'shortanswer' || type === 'numerical' || type === 'calculated') {
      question.typed = extractTyped($, $q);
    } else {
      question.options = extractOptions($, $q);
      if (!question.options.length) {
        // Tipo desconocido / essay: rescatamos el texto del bloque de respuesta.
        question.responseText = textOf($q.find('div.answer').first()) ||
          textOf($q.find('.qtype_essay_response').first());
      }
    }
    questions.push(question);
  });
  return questions;
}

function extractSummary($) {
  // Moodle moderno marca la tabla del resumen con .quizreviewsummary.
  let $table = $('table.quizreviewsummary').first();
  if (!$table.length) {
    $table = $('table.generaltable')
      .filter((_, t) => {
        const flat = $(t).text();
        return /Estado|Status/.test(flat) && /Calificación|Grade|Puntos|Marks/.test(flat);
      })
      .first();
  }
  const summary = {};
  if ($table.length) {
    $table.find('tr').each((_, tr) => {
      const cells = $(tr).find('th, td');
      if (cells.length === 2) {
        const k = collapse($(cells[0]).text());
        const v = collapse($(cells[1]).text());
        if (k) summary[k] = v;
      }
    });
  }
  return summary;
}

function questionSection(q) {
  const paras = [];
  if (q.qtext) paras.push(q.qtext);
  for (const o of q.options) {
    const marks = [];
    if (o.correct) marks.push('[correcta]');
    if (o.checked) marks.push('[tu respuesta]');
    paras.push(`${o.num} ${o.text}${marks.length ? ' ' + marks.join(' ') : ''}`.trim());
  }
  for (const m of q.matches) {
    const mark = m.correct ? ' [correcta]' : m.incorrect ? ' [incorrecta]' : '';
    paras.push(`${m.stem} → ${m.answer}${mark}`);
  }
  if (q.typed) {
    const mark = q.typed.correct ? ' [correcta]' : q.typed.incorrect ? ' [incorrecta]' : '';
    paras.push(`Tu respuesta: ${q.typed.value}${mark}`);
  }
  if (q.responseText) paras.push(q.responseText);
  if (q.rightanswer) paras.push(q.rightanswer);
  if (q.feedback) paras.push(q.feedback);
  const heading = `Pregunta ${q.no} — ${q.state}`.replace(/ — $/, '');
  return makeSection({ title: heading, level: 2, paragraphs: paras });
}

module.exports = {
  name: 'moodle',
  extensions: ['.htm', '.html'],
  description: 'Revisión de un cuestionario Moodle → examen estructurado',

  detect(data) {
    // La página de revisión siempre tiene divs `que`, pero mirar solo el primer
    // MB no alcanza: "Guardar página completa" mete el CSS del tema inline, y en
    // los cuestionarios largos las preguntas empiezan mucho después. Si esto
    // falla, el quiz cae al converter HTML genérico y sale como texto plano.
    if (data.includes('class="que ')) return true;
    return /<div[^>]+class="[^"]*\bque\b/.test(data.toString('utf8'));
  },

  async extract(data, filename, options = {}) {
    const $ = cheerio.load(decodeText(data));
    const baseDir = options.sourcePath ? path.dirname(options.sourcePath) : null;

    const questions = extractQuestions($, baseDir);
    if (!questions.length) {
      throw new Error('No parece la revisión de un cuestionario Moodle: no hay preguntas (div.que).');
    }
    const summary = extractSummary($);

    let title = '';
    const $title = $('title').first();
    if ($title.length) title = collapse($title.text()).split('|')[0].trim();
    if (!title) title = path.basename(filename, path.extname(filename));

    const nCorrect = questions.filter((q) => q.isCorrect).length;
    const nPartial = questions.filter((q) => q.isPartial).length;

    const sections = [];
    if (Object.keys(summary).length) {
      sections.push(makeSection({
        title: 'Resumen del intento',
        level: 2,
        paragraphs: Object.entries(summary).map(([k, v]) => `${k}: ${v}`),
      }));
    }
    for (const q of questions) sections.push(questionSection(q));

    return makeDocument({
      title,
      sections,
      metadata: {
        source: filename,
        engine: 'moodle (cheerio)',
        questions: questions.length,
        correct: nCorrect,
        quiz: {
          title,
          summary,
          questions,
          nCorrect,
          nPartial,
          nTotal: questions.length,
        },
      },
    });
  },
};
