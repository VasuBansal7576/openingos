import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../design/purchasing-workbench.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('the preserved prototype has a parseable bundled runtime', () => {
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /Accepted OpeningOS workbench/);
});

test('images and fonts are embedded and external connections are disabled', () => {
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 2);
  assert.equal((html.match(/data:font\/woff2;base64,/g) ?? []).length, 2);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /(?:src|href)=["'](?:https?:|\/assets\/)/);
  assert.doesNotMatch(html, /url\(["']?(?:https?:|\/assets\/)/);
  assert.doesNotMatch(html, /\/assets\/(?:machine|workbench|cafe)\.png/);
});

test('only the accepted design remains', () => {
  assert.match(html, /workbench-comparison/);
  assert.doesNotMatch(html, /scene-comparison|routes-comparison|Choose design|Explore designs|ONE OPENING\. THREE WAYS IN/);
});

test('the complete fixture walkthrough and truthful labels remain', () => {
  for (const copy of ['Start your own brief','Build my shortlist','Open the comparison','Approve demo message','Simulate supplier reply','Select this offer','Simulate a delivery delay','Prepare service case','No order was placed','Outside OpeningOS scope']) {
    assert.ok(html.includes(copy), `Missing screen or action: ${copy}`);
  }
  assert.doesNotMatch(script, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/);
});
