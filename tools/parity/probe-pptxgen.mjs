// Scratch probe: does the pptxgenjs deck `tool_pptx_write()` will be rebuilt from read back
// through python-pptx as the same text v1.0's own writer produces?
// Run: node tools/parity/probe-pptxgen.mjs
// Writes $TEMP/oracle-pptx-node.pptx, which tools/parity/make-pptx.py then reads with v1.0.
//
// `deckItems()` below is the paragraph/run model `src/main/tools/pptx-tools.ts` implements:
// python-pptx splits assigned text on "\n" into paragraphs, `append_text()` splits a paragraph on
// "\n" and "\v" into runs separated by `<a:br/>`, and every other control character is written as
// plain-text `_xNNNN_`.  `breakLine` gives the paragraph, `softBreakBefore` the line break.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable no-control-regex -- these code points are the characters python-pptx escapes */
import { writeFileSync } from 'fs'
import { join } from 'path'

import PptxGenJS from 'pptxgenjs'

const out = join(process.env.TEMP ?? process.env.TMP ?? '.', 'oracle-pptx-node.pptx')

const HEAD = { x: 0.5, y: 0.3004, w: 9, h: 1.25, fontSize: 44 }
const BODY = { x: 0.5, y: 1.75, w: 9, h: 4.9497, fontSize: 32 }
const TITLE = { x: 0.75, y: 2.33, w: 8.5, h: 1.6076, fontSize: 80 }
const SUBTITLE = { x: 1.5, y: 4.25, w: 7, h: 1.9167, fontSize: 40 }

/** `CT_RegularTextRun._escape_ctrl_chars()`. */
function escapeCtrlChars(text) {
  return text.replace(
    /[\x00-\x08\x0B-\x1F]/gu,
    (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`
  )
}

/** `CT_TextParagraph.append_text()` — the runs of one paragraph, joined by line breaks. */
function runsOf(paragraph) {
  return paragraph.split(/[\n\v]/u)
}

/** `TextFrame.text` setter for bullet 0, `add_paragraph().text` for the rest. */
function paragraphsOf(items) {
  const paragraphs = []
  items.forEach((text, index) => {
    if (index === 0) paragraphs.push(...text.split('\n'))
    else paragraphs.push(text)
  })
  return paragraphs
}

/** The pptxgenjs text objects for a whole text frame. */
function deckItems(items) {
  const paragraphs = paragraphsOf(items.map((text) => String(text)))
  const objects = []
  paragraphs.forEach((paragraph, pIndex) => {
    const runs = runsOf(paragraph)
    runs.forEach((run, rIndex) => {
      objects.push({
        text: escapeCtrlChars(run),
        options: {
          softBreakBefore: rIndex > 0,
          breakLine: rIndex === runs.length - 1 && pIndex + 1 < paragraphs.length
        }
      })
    })
  })
  return objects
}

const pptx = new PptxGenJS()

// `oracle-deck.pptx` slides 1-4.
const cover = pptx.addSlide()
cover.addText(deckItems(['Deck Title']), TITLE)
cover.addText(deckItems(['Deck Subtitle']), SUBTITLE)

const body = pptx.addSlide()
body.addText(deckItems(['Slide One']), HEAD)
body.addText(deckItems(['first bullet', 'second bullet', 'Ünïcode — naïve ✓']), BODY)
body.addNotes('Notes for slide one')

const none = pptx.addSlide()
none.addText(deckItems(['No Bullets']), HEAD)

const wide = pptx.addSlide()
wide.addText(deckItems(['Wide']), HEAD)
wide.addText(deckItems(['x'.repeat(200), '', 'tail']), BODY)

// `oracle-coerce.pptx` slides 2-5.
const types = pptx.addSlide()
types.addText(deckItems(['Types']), HEAD)
types.addText(deckItems(['42', 'True', 'None', '3.5', "[1, 'a']", "{'k': 'v'}"]), BODY)

const breaks = pptx.addSlide()
breaks.addText(deckItems(['Line\nBreak']), HEAD)
breaks.addText(deckItems(['first\nsecond', 'a\vb', 'q\tx']), BODY)
breaks.addNotes('n1\nn2')

const ctrl = pptx.addSlide()
ctrl.addText(deckItems(['Ctrl']), HEAD)
ctrl.addText(deckItems(['\x07bell', 'cr\rhere', '\x1besc']), BODY)

const later = pptx.addSlide()
later.addText(deckItems(['Later breaks']), HEAD)
later.addText(deckItems(['b0\nx', 'b1\ny', 'b2\vy']), BODY)

// `oracle-multi.pptx`: a multi-line title and subtitle.
const multi = pptx.addSlide()
multi.addText(deckItems(['Up\nDown']), TITLE)
multi.addText(deckItems(['S1\nS2']), SUBTITLE)

writeFileSync(out, await pptx.write({ outputType: 'nodebuffer' }))
console.log(out)
