import type { TriggerChanges, TriggerEvent } from '@sentinel0/common'

/** The slice of the database this needs, so the policy stays testable alone. */
export interface ObservationStore {
  observe(
    projectId: string,
    ref: string,
    current: { labels: string[]; assignees: string[]; reviewers: string[] }
  ): TriggerChanges | undefined
  watermarkFor(projectId: string): string | undefined
  advanceWatermark(projectId: string, createdAt: string | undefined): void
}

/**
 * Whether an item's first sighting is also its birth.
 *
 * Transitions cannot be observed the first time an item is seen -- there is
 * nothing to compare against -- and staying quiet is right when the item merely
 * predates the runner's first look, because otherwise creating a route would
 * fire it across an entire existing backlog.
 *
 * But "I have never seen this" and "this did not exist" are different facts,
 * and conflating them made a whole class of route impossible. A pull request
 * opened by a bot that requests a review three seconds later is *never* seen
 * without its reviewer already attached, so `reviewersAdded` had nothing to
 * detect on the only cycle that could have detected it. The same holds for a
 * human who fills in the reviewer field in the "Create pull request" form, and
 * for a ticket filed with its label already on.
 *
 * The watermark is the newest creation timestamp this runner has seen for a
 * project. Anything newer came into existence while we were watching, so
 * everything on it is genuinely new; anything older is backlog. Deliberately
 * the *provider's* clock on both sides -- comparing GitHub's timestamps against
 * this machine's would make a runner whose clock runs slow replay its backlog.
 */
export function isBornSinceWatermark(
  createdAt: string | undefined,
  watermark: string | undefined
): boolean {
  if (!createdAt || !watermark) {
    // No watermark yet means this is the project's first cycle, and everything
    // in it is backlog by definition. A provider that reports no creation time
    // gets the old, quiet behaviour.
    return false
  }
  return createdAt > watermark
}

/**
 * The transitions for an item that did not exist last time we looked.
 *
 * Everything on it really was just added, so this is not a fiction: it is what
 * the diff against the item's own non-existence actually is.
 */
export function changesForNewItem(event: TriggerEvent): TriggerChanges {
  return {
    labelsAdded: [...event.labels],
    labelsRemoved: [],
    assigneesAdded: [...(event.assignees ?? [])],
    assigneesRemoved: [],
    reviewersAdded: [...(event.requestedReviewers ?? [])],
  }
}

/**
 * The newest creation timestamp among a cycle's events, or undefined.
 *
 * Advanced once per cycle rather than per item so that two pull requests opened
 * between the same pair of polls cannot silence each other by ordering.
 */
export function newestCreatedAt(events: readonly TriggerEvent[]): string | undefined {
  let newest: string | undefined
  for (const event of events) {
    if (event.createdAt && (!newest || event.createdAt > newest)) {
      newest = event.createdAt
    }
  }
  return newest
}

/**
 * One cycle's worth of observation: records what every item looks like now and
 * returns the same events carrying what changed.
 *
 * This lives here, rather than inline in the poll loop, because both bugs this
 * function exists to prevent shipped past a green suite that re-implemented the
 * loop in a test helper. There is one implementation, and the tests drive it.
 *
 * Observed once per *item*, not per event: one pull request raises both a
 * pr_event and -- while a review is outstanding -- a pr_review_requested, and
 * they must read the same history. The watermark is read before the loop and
 * advanced after it, so two items created between the same pair of polls cannot
 * silence each other by ordering.
 */
export function observeCycle(
  db: ObservationStore,
  projectId: string,
  events: readonly TriggerEvent[]
): TriggerEvent[] {
  const watermark = db.watermarkFor(projectId)
  const observed = new Map<string, TriggerChanges | undefined>()

  const results = events.map((event) => {
    if (!observed.has(event.ref)) {
      const changes = db.observe(event.projectId, event.ref, {
        labels: event.labels,
        assignees: event.assignees ?? [],
        reviewers: event.requestedReviewers ?? [],
      })
      observed.set(
        event.ref,
        changes ??
          (isBornSinceWatermark(event.createdAt, watermark) ? changesForNewItem(event) : undefined)
      )
    }
    return { ...event, changes: observed.get(event.ref) }
  })

  db.advanceWatermark(projectId, newestCreatedAt(events))
  return results
}
