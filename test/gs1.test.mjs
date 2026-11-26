// Esegui con: node --test tracciabilita/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBarcode, gs1DateToIso, isValidGtin } from '../js/gs1.js';

const GS = '\x1d';

test('formato con parentesi (etichetta carne bovina)', () => {
  const r = parseBarcode('(01)98001234567890(3103)012345(17)261215(10)BOV-A123(251)IT012345678901(423)380(424)380(425)380');
  assert.equal(r.type, 'gs1');
  assert.equal(r.fields.gtin, '98001234567890');
  assert.equal(r.fields.pesoNettoKg, 12.345);
  assert.equal(r.fields.scadenza, '2026-12-15');
  assert.equal(r.fields.lotto, 'BOV-A123');
  assert.equal(r.fields.rifOrigine, 'IT012345678901');
  assert.equal(r.fields.paesePrimaLavorazione, 'Italia');
  assert.equal(r.fields.paeseLavorazione, 'Italia');
  assert.deepEqual(r.errors, []);
});

test('stringa grezza con FNC1 (GS) dopo campo variabile', () => {
  const r = parseBarcode(']C101980012345678901026A99X' + GS + '17270131' + '3102001500');
  assert.equal(r.fields.lotto, '26A99X');
  assert.equal(r.fields.scadenza, '2027-01-31');
  assert.equal(r.fields.pesoNettoKg, 15);
});

test('separatore sostitutivo | (scanner in modalità tastiera)', () => {
  const r = parseBarcode('0108001234567897101234|1526063000');
  assert.equal(r.fields.lotto, '1234');
  assert.equal(r.fields.tmc, '2026-06-30');
});

test('lotto come ultimo campo senza separatore', () => {
  const r = parseBarcode('010800123456789717261130' + '10LOTTO77');
  assert.equal(r.fields.scadenza, '2026-11-30');
  assert.equal(r.fields.lotto, 'LOTTO77');
});

test('giorno 00 = ultimo giorno del mese', () => {
  assert.equal(gs1DateToIso('270200'), '2027-02-28');
  assert.equal(gs1DateToIso('281300'), null);
});

test('EAN-13 semplice', () => {
  const r = parseBarcode('8001234567890');
  assert.equal(r.type, 'ean');
  assert.equal(r.fields.gtin, '08001234567890');
});

test('EAN-13 a peso variabile (prefisso 2)', () => {
  const r = parseBarcode('2123450012347');
  assert.equal(r.fields.pesoVariabile, true);
});

test('codice interno (testo libero)', () => {
  const r = parseBarcode('LAS-261126-01');
  assert.equal(r.type, 'testo');
});

test('bollo CE stabilimento AI 7030', () => {
  const r = parseBarcode('(01)98001234567890(10)X1(7030)380IT1234L');
  assert.equal(r.fields.stabilimento0, 'Italia IT1234L');
});

test('check digit GTIN', () => {
  assert.equal(isValidGtin('4006381333931'), true);
  assert.equal(isValidGtin('4006381333932'), false);
  assert.equal(isValidGtin('98001234567890'), true);
});
