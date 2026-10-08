#let todo(body) = context {
  h(0.3em, weak: true)
  highlight(fill: rgb("#ffe3e3"), extent: 1pt, text(size: 0.88em, fill: rgb("#a61e1e"))[*To do:* #body])
  h(0.3em, weak: true)
}
