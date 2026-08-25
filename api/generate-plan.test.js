'use strict';

// Standalone CJS test — copy of detectExhaustedByThinking from generate-plan.js
function detectExhaustedByThinking(data) {
  if (data.stop_reason !== 'max_tokens') return false;
  var textBlocks = Array.isArray(data.content)
    ? data.content.filter(function(b) { return b.type === 'text'; })
    : [];
  return textBlocks.length === 0;
}

var tests = [];
function test(name, fn) {
  try {
    var ok = fn();
    tests.push({ name: name, passed: ok, message: ok ? '' : 'returned false' });
  } catch (e) {
    tests.push({ name: name, passed: false, message: e.message });
  }
}

// TEST A: thinking blocks only + stop_reason=max_tokens → exhausted
test('TEST A: content=[thinking], stop_reason=max_tokens → MODEL_OUTPUT_EXHAUSTED_BY_THINKING', function() {
  var data = {
    stop_reason: 'max_tokens',
    usage: { output_tokens: 8000, thinking_tokens: 8000 },
    content: [{ type: 'thinking', thinking: 'some internal reasoning...' }]
  };
  return detectExhaustedByThinking(data) === true;
});

// TEST B: thinking + text → text extracted normally, not exhausted
test('TEST B: content=[thinking,text], stop_reason=end_turn → extraer text correctamente', function() {
  var data = {
    stop_reason: 'end_turn',
    usage: { output_tokens: 6000, thinking_tokens: 2000 },
    content: [
      { type: 'thinking', thinking: 'reasoning...' },
      { type: 'text',    text: '{"schema":"vdsen-plan-v2","entrenamiento":{}}' }
    ]
  };
  if (detectExhaustedByThinking(data) !== false) return false;
  // Also verify text extraction pattern used in coach
  var textBlocks = data.content.filter(function(c) { return c.type === 'text'; });
  var text = textBlocks.map(function(c) { return c.text; }).join('\n');
  return text === '{"schema":"vdsen-plan-v2","entrenamiento":{}}';
});

// TEST C: text only, end_turn → normal flow, not exhausted
test('TEST C: content=[text], stop_reason=end_turn → flujo normal', function() {
  var data = {
    stop_reason: 'end_turn',
    usage: { output_tokens: 3000 },
    content: [{ type: 'text', text: '{"schema":"vdsen-plan-v2"}' }]
  };
  return detectExhaustedByThinking(data) === false;
});

// TEST D (edge): max_tokens but text IS present → truncated but not exhausted
test('TEST D (edge): stop_reason=max_tokens + text presente → no exhausted (truncado)', function() {
  var data = {
    stop_reason: 'max_tokens',
    content: [
      { type: 'thinking', thinking: '...' },
      { type: 'text',    text: '{"schema":"vdsen-plan-v2","entrenamiento":{' }
    ]
  };
  return detectExhaustedByThinking(data) === false;
});

// Print results
var passed = 0;
tests.forEach(function(t) {
  var icon = t.passed ? '✅' : '❌';
  console.log(icon + ' ' + t.name);
  if (!t.passed) console.log('   → ' + t.message);
  if (t.passed) passed++;
});
console.log('\n' + passed + '/' + tests.length + ' passed');
process.exit(passed === tests.length ? 0 : 1);
