import { describe, expect, it } from 'vitest'
import { TICKET_PROVIDER, TRIGGER_TYPE, type TriggerEvent } from '@sentinel0/common'
import {
  changesForNewItem,
  isBornSinceWatermark,
  newestCreatedAt,
} from '../../src/triggers/history.js'

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    type: TRIGGER_TYPE.PR_EVENT,
    projectId: 'trackside',
    provider: TICKET_PROVIDER.GITHUB,
    ref: 'acme/trackside#7',
    revision: 'r1',
    title: 'Fix the export',
    body: '',
    labels: [],
    assignees: [],
    requestedReviewers: [],
    ...overrides,
  }
}

describe('isBornSinceWatermark', () => {
  it('is true for an item created after the newest one already seen', () => {
    expect(isBornSinceWatermark('2026-09-07T13:19:18Z', '2026-09-07T12:00:00Z')).toBe(true)
  })

  it('is false for the backlog', () => {
    expect(isBornSinceWatermark('2026-09-01T09:00:00Z', '2026-09-07T12:00:00Z')).toBe(false)
  })

  it('is false at the watermark itself, so nothing fires twice on a boundary', () => {
    expect(isBornSinceWatermark('2026-09-07T12:00:00Z', '2026-09-07T12:00:00Z')).toBe(false)
  })

  it('is false on a project’s first cycle, when everything visible is backlog', () => {
    expect(isBornSinceWatermark('2026-09-07T13:19:18Z', undefined)).toBe(false)
  })

  it('is false when the provider reports no creation time', () => {
    // The old, quiet behaviour rather than a guess.
    expect(isBornSinceWatermark(undefined, '2026-09-07T12:00:00Z')).toBe(false)
  })
})

describe('changesForNewItem', () => {
  it('reports everything on the item as added', () => {
    const changes = changesForNewItem(
      event({ labels: ['bug'], assignees: ['maxi'], requestedReviewers: ['EomiAIBot'] })
    )

    expect(changes).toEqual({
      labelsAdded: ['bug'],
      labelsRemoved: [],
      assigneesAdded: ['maxi'],
      assigneesRemoved: [],
      reviewersAdded: ['EomiAIBot'],
    })
  })

  it('copies rather than aliases the event’s own arrays', () => {
    const source = event({ labels: ['bug'] })
    changesForNewItem(source).labelsAdded.push('mutated')

    expect(source.labels).toEqual(['bug'])
  })
})

describe('newestCreatedAt', () => {
  it('takes the maximum regardless of the order they arrive in', () => {
    const events = [
      event({ createdAt: '2026-09-07T13:00:00Z' }),
      event({ createdAt: '2026-09-07T14:00:00Z' }),
      event({ createdAt: '2026-09-07T12:00:00Z' }),
    ]
    expect(newestCreatedAt(events)).toBe('2026-09-07T14:00:00Z')
  })

  it('ignores events with no creation time', () => {
    expect(newestCreatedAt([event(), event({ createdAt: '2026-09-07T13:00:00Z' })])).toBe(
      '2026-09-07T13:00:00Z'
    )
  })

  it('is undefined when nothing reports one, so the watermark stays put', () => {
    expect(newestCreatedAt([event(), event()])).toBeUndefined()
    expect(newestCreatedAt([])).toBeUndefined()
  })
})
