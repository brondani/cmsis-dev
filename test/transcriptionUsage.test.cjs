const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTranscriptionUsage } = require('../out/workflows/transcriptionUsage');

test('sums provider-reported token counts across chunks', () => {
  assert.deepEqual(formatTranscriptionUsage([
    { type: 'tokens', input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    { type: 'tokens', input_tokens: 20, output_tokens: 3, total_tokens: 23 }
  ]), [
    '- Input tokens: 30 tokens',
    '- Output tokens: 5 tokens'
  ]);
});

test('omits billable duration and total tokens even when reported', () => {
  assert.deepEqual(formatTranscriptionUsage([
    { type: 'duration', seconds: 180 },
    { type: 'duration', seconds: 65.5 }
  ]), [
    '- Transcription tokens: Not reported by provider.'
  ]);
  assert.deepEqual(formatTranscriptionUsage([{ type: 'tokens', total_tokens: 35 }]), [
    '- Transcription tokens: Not reported by provider.'
  ]);
});

test('marks incomplete and mixed usage without estimating missing counts', () => {
  assert.deepEqual(formatTranscriptionUsage([
    { type: 'tokens', input_tokens: 10, output_tokens: 2 },
    undefined,
    { type: 'duration', seconds: 30 }
  ]), [
    '- Input tokens: 10 tokens (reported for 1/3 chunks)',
    '- Output tokens: 2 tokens (reported for 1/3 chunks)'
  ]);
  assert.deepEqual(formatTranscriptionUsage([undefined]), [
    '- Transcription tokens: Not reported by provider.'
  ]);
});