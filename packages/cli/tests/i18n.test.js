'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CATALOGUES, createTranslator, detectLocale, interpolate } = require('../src/i18n');

test('both catalogues define exactly the same keys', () => {
  const english = Object.keys(CATALOGUES.en).sort();
  const chinese = Object.keys(CATALOGUES.zh).sort();

  const missingInChinese = english.filter((key) => !(key in CATALOGUES.zh));
  const missingInEnglish = chinese.filter((key) => !(key in CATALOGUES.en));

  assert.deepEqual(missingInChinese, [], `missing Chinese translations: ${missingInChinese.join(', ')}`);
  assert.deepEqual(missingInEnglish, [], `missing English translations: ${missingInEnglish.join(', ')}`);
});

test('every catalogue entry is a non-empty string', () => {
  for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
    for (const [key, value] of Object.entries(catalogue)) {
      assert.equal(typeof value, 'string', `${locale}.${key} is not a string`);
      assert.ok(value.length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('translations use the same placeholders in both languages', () => {
  const placeholders = (value) => (value.match(/\{\w+\}/g) || []).sort();
  for (const key of Object.keys(CATALOGUES.en)) {
    assert.deepEqual(
      placeholders(CATALOGUES.zh[key]),
      placeholders(CATALOGUES.en[key]),
      `placeholders differ for ${key}`,
    );
  }
});

test('locale detection follows the preference, then the environment', () => {
  assert.equal(detectLocale({ preference: 'zh', env: { LANG: 'en_US.UTF-8' } }), 'zh');
  assert.equal(detectLocale({ preference: 'en', env: { LANG: 'zh_CN.UTF-8' } }), 'en');

  assert.equal(detectLocale({ preference: 'auto', env: { LANG: 'zh_CN.UTF-8' } }), 'zh');
  assert.equal(detectLocale({ preference: 'auto', env: { LANG: 'en_GB.UTF-8' } }), 'en');
  assert.equal(detectLocale({ preference: 'auto', env: { LC_ALL: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' } }), 'zh');
  assert.equal(detectLocale({ preference: 'auto', env: {} }), 'en');
  assert.equal(detectLocale({ preference: 'auto', env: { HERDR_REMOTE_LANG: 'zh', LANG: 'en_US.UTF-8' } }), 'zh');
});

test('an unknown key falls back to English and then to the key itself', () => {
  const zh = createTranslator('zh');
  assert.equal(zh('nav.overview'), '概览');
  assert.equal(zh('definitely.not.a.key'), 'definitely.not.a.key');
});

test('interpolation replaces named placeholders only', () => {
  assert.equal(interpolate('port {port} on {host}', { port: 8787, host: 'x' }), 'port 8787 on x');
  assert.equal(interpolate('keeps {unknown}', { other: 1 }), 'keeps {unknown}');
});
