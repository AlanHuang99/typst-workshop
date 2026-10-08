#let template(body) = {
  show heading: it => block[Appendix #it.body]
  set math.equation(numbering: n => [(#n)])
  body
}
