/**
 * Sentences with values set in them.
 *
 * The assistant answers in one sentence, and the numbers in that sentence are what the eye
 * looks for: "4,4 W", "20,4 °C", "TV du salon". Those get an icon and a rounded background,
 * inline, so the sentence stays a sentence and the values still stand out.
 *
 * The markup is `[[ph:icon|text]]` or `[[ph:icon|text|tone]]`. It is parsed into segments -
 * data, never HTML - so a device named `<img onerror=...>` renders as those characters. The
 * same sentence has a spoken form with the markup removed, because a voice reading out
 * "double crochet ph deux points lightning" is worse than no chips at all.
 */

import { describe, expect, test } from 'bun:test'
import { chip, parseRichText, stripRichText } from '../src/rich_text'

describe('parsing', () => {
  test('plain text is one text segment', () => {
    expect(parseRichText('Tout va bien.')).toEqual([{ kind: 'text', text: 'Tout va bien.' }])
  })

  test('a chip between words', () => {
    expect(parseRichText('On consomme [[ph:lightning|4,4 W]] en ce moment.')).toEqual([
      { kind: 'text', text: 'On consomme ' },
      { kind: 'chip', icon: 'ph:lightning', text: '4,4 W', tone: 'default' },
      { kind: 'text', text: ' en ce moment.' },
    ])
  })

  test('a chip carries its tone', () => {
    const [segment] = parseRichText('[[ph:warning|TV du salon|warn]]')
    expect(segment).toEqual({ kind: 'chip', icon: 'ph:warning', text: 'TV du salon', tone: 'warn' })
  })

  test('an unknown tone falls back to the default rather than dropping the chip', () => {
    const [segment] = parseRichText('[[ph:warning|TV|purple]]')
    expect(segment).toMatchObject({ kind: 'chip', tone: 'default' })
  })

  test('an icon outside the Phosphor set stays literal text', () => {
    // The icon name ends up in a component prop; only a known, boring shape is accepted.
    expect(parseRichText('[[javascript:alert(1)|x]]')).toEqual([{ kind: 'text', text: '[[javascript:alert(1)|x]]' }])
    expect(parseRichText('[[ph:Bad_Name|x]]')).toEqual([{ kind: 'text', text: '[[ph:Bad_Name|x]]' }])
  })

  test('markup inside a chip is text, not markup', () => {
    const [segment] = parseRichText('[[ph:house|<img src=x onerror=alert(1)>]]')
    expect(segment).toEqual({ kind: 'chip', icon: 'ph:house', text: '<img src=x onerror=alert(1)>', tone: 'default' })
    expect(parseRichText('<b>gras</b>')).toEqual([{ kind: 'text', text: '<b>gras</b>' }])
  })

  test('an unclosed chip stays literal', () => {
    expect(parseRichText('Voir [[ph:lightning|4,4 W')).toEqual([{ kind: 'text', text: 'Voir [[ph:lightning|4,4 W' }])
  })

  test('several chips in one sentence, adjacent or not', () => {
    const segments = parseRichText('[[ph:lightning|4 W]][[ph:drop|45 %]] et [[ph:sun|120 lx]]')
    expect(segments.filter((segment) => segment.kind === 'chip')).toHaveLength(3)
  })
})

describe('the spoken form', () => {
  test('chips are read as their text', () => {
    expect(stripRichText('Tout va bien : [[ph:lightning|4,4 W]] et [[ph:thermometer-simple|20,4 °C|ok]].')).toBe('Tout va bien : 4,4 W et 20,4 °C.')
  })

  test('text without chips is untouched', () => {
    expect(stripRichText('Rien à signaler.')).toBe('Rien à signaler.')
  })

  test('literal brackets that are not a chip are left alone', () => {
    expect(stripRichText('[[pas un chip]]')).toBe('[[pas un chip]]')
  })
})

describe('building a chip', () => {
  test('round-trips through the parser', () => {
    const token = chip('ph:lightning', '4,4 W', 'warn')
    expect(parseRichText(token)).toEqual([{ kind: 'chip', icon: 'ph:lightning', text: '4,4 W', tone: 'warn' }])
  })

  test('a device name cannot break out of the chip', () => {
    const token = chip('ph:lightbulb', 'Lampe | bizarre ]] nom')
    const segments = parseRichText(`avant ${token} après`)
    expect(segments).toHaveLength(3)
    expect(segments[1]).toMatchObject({ kind: 'chip' })
    expect(stripRichText(`avant ${token} après`).startsWith('avant Lampe')).toBe(true)
  })

  test('a very long text is shortened, so a chip never becomes a paragraph', () => {
    const [segment] = parseRichText(chip('ph:warning', 'x'.repeat(200)))
    expect((segment as { text: string }).text.length).toBeLessThanOrEqual(60)
  })

  test('an invalid icon produces plain text instead of a broken token', () => {
    expect(chip('not an icon', 'valeur')).toBe('valeur')
  })
})
