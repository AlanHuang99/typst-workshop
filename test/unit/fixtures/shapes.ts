/** The include structure of a manuscript with sections, tables, an appendix and a template, as file → text. */
export const manuscript = new Map<string, string>([
  ['/w/Manuscript.typ', '#import "Others/template.typ": *\n// #include "Sections/related.typ"\n#include "Sections/methods.typ"\n#include "Sections/results.typ"\n#include "appendix.typ"'],
  ['/w/Sections/results.typ', '#import "../Others/template.typ": *\n#include "../Tables/results_table.typ"'],
  ['/w/Sections/methods.typ', '#import "../Others/template.typ": *\n#include "../Tables/definitions.typ"'],
  ['/w/Sections/related.typ', '#import "../Others/template.typ": *\nText.'],
  ['/w/appendix.typ', '#import "Others/template.typ": *\n#include "Tables/appendix_table.typ"'],
  ['/w/Tables/results_table.typ', '#import "../Others/template.typ": *'],
  ['/w/Tables/definitions.typ', '#import "../Others/template.typ": *'],
  ['/w/Tables/appendix_table.typ', '#import "../Others/template.typ": *'],
  ['/w/Others/template.typ', '#let manuscript(body) = body'],
]);
