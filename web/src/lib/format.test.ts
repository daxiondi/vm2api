import { afterEach, describe, expect, it, vi } from 'vitest'
import { fmtTok, fmtUsd, pct, remainPct, usedPctOf } from '@/lib/format'

afterEach(() => vi.unstubAllGlobals())

describe('fmtUsd', () => {
  it('preserves existing dollar formatting when billing is active', () => {
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(null)).toBe('$0')
    expect(fmtUsd(undefined)).toBe('$0')
    expect(fmtUsd(100)).toBe('$100.00')
    expect(fmtUsd(1.234)).toBe('$1.234')
    expect(fmtUsd(0.12345)).toBe('$0.1235')
    expect(fmtUsd(1.234, 2)).toBe('$1.23')
  })

  it.each([0, null, undefined, 123.45, Number.NaN])(
    'shows unavailable instead of a dollar amount while paused: %s',
    (value) => {
      vi.stubGlobal('__VM2API_ADMIN_BILLING_PAUSED__', true)
      expect(fmtUsd(value)).toBe('—')
      expect(fmtUsd(value, 2)).toBe('—')
    }
  )

  it('restores dollar formatting after billing resumes', () => {
    vi.stubGlobal('__VM2API_ADMIN_BILLING_PAUSED__', true)
    expect(fmtUsd(0)).toBe('—')

    vi.stubGlobal('__VM2API_ADMIN_BILLING_PAUSED__', false)
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(12.5)).toBe('$12.500')
  })
})

describe('usedPctOf', () => {
  it('prefers Codex used_percent and does not scale it', () => {
    expect(
      usedPctOf(
        {
          utilization_5h: 0.06,
          utilization_7d: 0.34,
          codex_usage: {
            windows: [
              { id: '5h', used_percent: 6 },
              { id: '7d', used_percent: 34 },
            ],
          },
        },
        '5h'
      )
    ).toBe(6)
    expect(
      usedPctOf(
        {
          utilization_5h: 1,
          codex_usage: { windows: [{ id: '5h', used_percent: 1 }] },
        },
        '5h'
      )
    ).toBe(1)
  })

  it('falls back to utilization ratio', () => {
    expect(usedPctOf({ utilization_5h: 0.12, utilization_7d: 0.4 }, '7d')).toBe(
      40
    )
  })
})

describe('pct', () => {
  it('keeps leftover 0-100 numbers', () => {
    expect(pct(12)).toBe(12)
    expect(remainPct(12)).toBe(88)
  })

  it('treats 0-1 utilization as a fraction', () => {
    expect(pct(0.12)).toBe(12)
  })

  it('scales utilization ratios above 1 (Claude headers)', () => {
    expect(pct(0.99)).toBe(99)
    expect(pct(1)).toBe(100)
    expect(pct(1.01)).toBe(101)
    expect(pct(1.04)).toBe(104)
  })
})

describe('fmtTok', () => {
  it('reads the OpenAI cache read from nested token details', () => {
    expect(
      fmtTok({
        input_tokens: 120,
        output_tokens: 9,
        usage: { input_tokens_details: { cached_tokens: 8 } },
      })
    ).toBe('120/9 · c8/0')
    expect(
      fmtTok({
        input_tokens: 120,
        output_tokens: 9,
        usage: { prompt_tokens_details: { cached_tokens: 5 } },
      })
    ).toBe('120/9 · c5/0')
  })

  it('keeps the top-level column authoritative', () => {
    expect(
      fmtTok({
        input_tokens: 120,
        output_tokens: 9,
        cache_read_tokens: 8,
        cache_creation_tokens: 2,
        usage: { input_tokens_details: { cached_tokens: 999 } },
      })
    ).toBe('120/9 · c8/2')
  })
})
