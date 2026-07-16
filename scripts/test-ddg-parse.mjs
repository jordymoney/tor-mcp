import assert from 'node:assert/strict'
import { parseDdgHtmlResults } from '../research.mjs'

const sample = `
<div class="result results_links results_links_deep result--ad ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dx&amp;rut=1">Ad Skip</a>
    </h2>
  </div>
</div>
<div class="result results_links results_links_deep">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fsoundproofgeek.com%2Fquietest%2Ddesk%2Dfan%2F&amp;rut=abc">Quietest Desk Fan</a>
    </h2>
    <a class="result__snippet" href="#">A roundup of silent table fans for desks.</a>
  </div>
</div>
<div class="result results_links results_links_deep">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.amazon.com%2Fs%3Fk%3Dsilent%2520desk%2520fan&amp;rut=xyz">Amazon silent desk fan</a>
    </h2>
  </div>
</div>
`

const hits = parseDdgHtmlResults(sample, 5)
assert.equal(hits.length, 2, `expected 2 organic hits, got ${hits.length}`)
assert.equal(hits[0].url, 'https://soundproofgeek.com/quietest-desk-fan/')
assert.match(hits[0].title, /Quietest Desk Fan/)
assert.equal(hits[1].url, 'https://www.amazon.com/s?k=silent%20desk%20fan')
console.log('parseDdgHtmlResults OK', hits)
