import {
  COMMENT_TARGET,
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  type CommentTarget,
  type ProjectConfig,
  type TriggerEvent,
} from '@sentinel0/common'
import type { TrackerWriter, TriggerSource } from '../triggers/types.js'
import type { GitHubPullRequest, GitHubRestClient } from '@sentinel0/common/github'

export function requireRepo(project: ProjectConfig): { owner: string; repo: string } {
  if (project.provider !== TICKET_PROVIDER.GITHUB) {
    throw new Error(`Project "${project.id}" is not configured to pull from GitHub.`)
  }
  const { owner, repo } = project.filters
  if (!owner || !repo) {
    throw new Error(`GitHub project "${project.id}" requires filters.owner and filters.repo.`)
  }
  return { owner, repo }
}

export function parseIssueNumber(ref: string): number {
  const match = ref.match(/#(\d+)$/)
  if (!match) {
    throw new Error(`Unable to parse an issue or PR number from "${ref}".`)
  }
  return Number.parseInt(match[1], 10)
}

/** Orange, matching Sentinel0's own colour, so managed labels read as a set. */
const SENTINEL0_LABEL_COLOR = 'f97316'

export class GitHubService implements TriggerSource, TrackerWriter {
  readonly name = 'github'

  constructor(private readonly api: GitHubRestClient) {}

  // ── Trigger source ─────────────────────────────────────────

  async collect(project: ProjectConfig): Promise<TriggerEvent[]> {
    if (project.provider !== TICKET_PROVIDER.GITHUB) {
      return []
    }
    const [issues, pullRequests] = await Promise.all([
      this.collectIssues(project),
      this.collectPullRequests(project),
    ])
    return [...issues, ...pullRequests]
  }

  private async collectIssues(project: ProjectConfig): Promise<TriggerEvent[]> {
    const { owner, repo } = requireRepo(project)
    const { state = 'open', labels } = project.filters

    const issues = await this.api.issues(owner, repo, { state, labels })

    return issues.map((issue) => ({
      type: TRIGGER_TYPE.TICKET,
      projectId: project.id,
      provider: TICKET_PROVIDER.GITHUB,
      ref: `${owner}/${repo}#${issue.number}`,
      // updated_at is GitHub's own "has this changed" signal, which makes it
      // the natural revision: relabel or edit a ticket and the route fires
      // again; leave it alone and every later poll is a no-op.
      revision: issue.updated_at ?? '',
      createdAt: issue.created_at,
      title: issue.title,
      body: issue.body ?? '',
      url: issue.html_url,
      state: issue.state,
      labels: issue.labels?.map((label) => label.name) ?? [],
      assignees: logins(issue.assignees),
    }))
  }

  /**
   * Every open pull request, as both a general `pr_event` and — when someone is
   * actually awaiting review — a `pr_review_requested`.
   *
   * The general event is emitted unconditionally. Previously PRs were only
   * looked at when a reviewer had been requested, so a route keyed on a label
   * or an assignee never saw the pull request at all.
   */
  private async collectPullRequests(project: ProjectConfig): Promise<TriggerEvent[]> {
    const { owner, repo } = requireRepo(project)
    const pulls = await this.api.pullRequests(owner, repo)

    const events: TriggerEvent[] = []

    for (const pull of pulls) {
      const reviewers = reviewerLogins(pull)
      const base = {
        projectId: project.id,
        provider: TICKET_PROVIDER.GITHUB,
        ref: `${owner}/${repo}#${pull.number}`,
        createdAt: pull.created_at,
        title: pull.title,
        body: pull.body ?? '',
        url: pull.html_url,
        state: pull.state,
        labels: pull.labels?.map((label) => label.name) ?? [],
        assignees: logins(pull.assignees),
        prNumber: pull.number,
        requestedReviewers: reviewers,
        isDraft: pull.draft,
        baseBranch: pull.base?.ref,
      }

      events.push({
        ...base,
        type: TRIGGER_TYPE.PR_EVENT,
        // Assignee and reviewer sets are not reliably reflected in updated_at,
        // so they are folded in: adding someone must count as a change.
        revision: [
          pull.updated_at ?? '',
          base.assignees.slice().sort().join(','),
          reviewers.slice().sort().join(','),
          base.labels.slice().sort().join(','),
        ].join('|'),
      })

      if (reviewers.length > 0) {
        events.push({
          ...base,
          type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
          revision: `${pull.updated_at ?? ''}|${reviewers.slice().sort().join(',')}`,
        })
      }
    }

    return events
  }

  // ── Tracker writer ─────────────────────────────────────────

  async postComment(_target: CommentTarget, event: TriggerEvent, body: string): Promise<void> {
    const { owner, repo } = splitRef(event.ref)
    // Issues and PRs share the issues comment endpoint on GitHub, so both
    // comment targets resolve to the same call.
    await this.api.createComment(owner, repo, parseIssueNumber(event.ref), body)
  }

  async updateLabels(
    event: TriggerEvent,
    labels: { add?: string[]; remove?: string[] }
  ): Promise<void> {
    const { owner, repo } = splitRef(event.ref)
    const number = parseIssueNumber(event.ref)

    const toAdd = labels.add ?? []
    const toRemove = labels.remove ?? []
    if (toAdd.length === 0 && toRemove.length === 0) {
      return
    }

    for (const label of toAdd) {
      await this.api.ensureLabel(owner, repo, label, SENTINEL0_LABEL_COLOR, 'Managed by Sentinel0')
    }
    await this.api.addLabels(owner, repo, number, toAdd)

    // One call per label: GitHub's removal endpoint addresses a single name in
    // the path, and there is no batch form.
    for (const label of toRemove) {
      await this.api.removeLabel(owner, repo, number, label)
    }
  }
}

export const COMMENT_TARGETS_HANDLED: CommentTarget[] = [COMMENT_TARGET.TICKET, COMMENT_TARGET.PR]

/**
 * Everyone whose review is outstanding, users and teams alike.
 *
 * `gh` reported both in one `reviewRequests` array; the REST API splits them,
 * and dropping the teams half would make a route targeting a review-owning
 * team silently never match.
 */
function reviewerLogins(pull: GitHubPullRequest): string[] {
  return [
    ...(pull.requested_reviewers ?? []).map((user) => user.login),
    ...(pull.requested_teams ?? []).map((team) => team.slug),
  ].filter((login): login is string => Boolean(login))
}

function logins(users?: Array<{ login?: string }>): string[] {
  return (users ?? []).map((user) => user.login).filter((login): login is string => Boolean(login))
}

export function splitRef(ref: string): { owner: string; repo: string } {
  const match = ref.match(/^([^/]+)\/([^#]+)#\d+$/)
  if (!match) {
    throw new Error(`Malformed GitHub ref "${ref}"; expected owner/repo#number.`)
  }
  return { owner: match[1], repo: match[2] }
}
