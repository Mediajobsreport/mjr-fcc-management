import test from 'node:test';
import assert from 'node:assert/strict';
import { fccService, serviceMatches } from '../fcc_service.js';
import worker from '../fcc_transactions_worker.js';

test('keeps TV translators out of radio even with missing or incorrect cached service', () => {
  for (const call of ['K18NX-D', 'K21QD-D', 'K33RQ-D', 'K31QT-D', 'K29PA-D', 'W23EQ-D', 'W29ES-D', 'WBND-LD', 'KAXT-CD']) {
    for (const service of ['', 'radio', 'LPT', 'LPD']) {
      assert.equal(fccService({call, service}), 'television', `${call}: ${service}`);
      assert.equal(serviceMatches({call, service}, 'radio'), false);
    }
  }
});

test('recognizes FCC radio and TV service codes without substring matches', () => {
  for (const service of ['AM', 'FM', 'FX', 'FL', 'FB', 'LPFM']) assert.equal(fccService({service}), 'radio');
  for (const service of ['DTV', 'LPT', 'LPD', 'DCA', 'TX', 'TV']) assert.equal(fccService({service}), 'television');
  assert.equal(fccService({service: 'unknown translator'}), '');
  assert.equal(fccService({call: 'UNKNOWN'}), '');
  assert.equal(fccService({call: 'K282CI'}), 'radio');
  assert.equal(fccService({call: 'WAMR-FM'}), 'radio');
});

test('public API repairs old cache partitions and preserves query filtering', async () => {
  const rows = [
    {call: 'K18NX-D', filed: new Date().toISOString(), file: '123'},
    {call: 'WAMR-FM', service: 'FM', filed: new Date().toISOString(), file: '456'}
  ];
  const env = {FCC_CACHE: {async get(key) {return {data: key.endsWith(':radio') ? [rows[0]] : rows, connected: true};}}};
  for (const [service, expected] of [['radio', 'WAMR-FM'], ['television', 'K18NX-D']]) {
    const response = await worker.fetch(new Request(`https://example.com/api/fcc/transactions?service=${service}`), env);
    const result = await response.json();
    assert.deepEqual(result.data.map(row => row.call), [expected]);
    assert.equal(result.data[0].service, service);
  }
  const result = await (await worker.fetch(new Request('https://example.com/api/fcc/transactions?service=radio&search=K18NX'), env)).json();
  assert.equal(result.data.length, 0);
});
