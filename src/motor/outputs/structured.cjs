'use strict';
/** Output JSON estructurado: el árbol completo del Document. */

function sectionJson(s) {
  return {
    title: s.title,
    level: s.level,
    paragraphs: s.paragraphs,
    tables: s.tables,
    subsections: s.subsections.map(sectionJson),
  };
}

module.exports = {
  name: 'json',
  extension: '.json',
  description: 'JSON estructurado (el árbol completo)',

  async render(doc) {
    const tree = {
      title: doc.title,
      metadata: doc.metadata,
      sections: doc.sections.map(sectionJson),
    };
    return Buffer.from(JSON.stringify(tree, null, 2), 'utf8');
  },
};
