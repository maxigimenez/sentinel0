import { describe, expect, it } from 'vitest'
import { parseApproveOptions, parseCancelOptions } from '../src/args.js'

describe('parseApproveOptions', () => {
  /**
   * Approving for the run rather than for the single call.
   *
   * An agent that stopped mid-task asks again as soon as it takes the next
   * step, so `once` as a default would mean answering the same question four
   * times to let one task finish.
   */
  it('defaults to approving for the rest of the run', () => {
    expect(parseApproveOptions(['pxr_1'])).toEqual({ runId: 'pxr_1', choice: 'session' })
  })

  it.each([
    ['--once', 'once'],
    ['--session', 'session'],
    ['--always', 'always'],
    ['--deny', 'deny'],
  ])('passes %s through as Hermes spells it', (flag, choice) => {
    expect(parseApproveOptions(['pxr_1', flag])).toEqual({ runId: 'pxr_1', choice })
  })

  it('refuses two answers at once rather than picking one', () => {
    expect(() => parseApproveOptions(['pxr_1', '--deny', '--always'])).toThrow(/one of/)
  })

  it('requires a run id', () => {
    expect(() => parseApproveOptions(['--deny'])).toThrow(/run id/)
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseApproveOptions(['pxr_1', '--yes'])).toThrow()
  })
})

describe('parseCancelOptions', () => {
  it('still takes a bare run id', () => {
    expect(parseCancelOptions(['pxr_1'])).toEqual({ runId: 'pxr_1' })
  })
})
