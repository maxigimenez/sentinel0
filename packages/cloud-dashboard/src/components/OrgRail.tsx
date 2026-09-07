import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useSession } from '../lib/session.js'

/**
 * The organization's second-level navigation.
 *
 * The design (`sentinel0 App Noir.dc.html`, `showOrgRail`) puts a 190px rail
 * between the primary sidebar and the page whenever an organization page is
 * open. It exists because the organization group had outgrown a flat list: with
 * Integrations added there are five destinations, each a settings surface
 * rather than a view of work, and promoting all five into the primary sidebar
 * would have buried Runs and Routes among them.
 *
 * Each entry carries a hint under its label. That is not decoration — these
 * pages are visited rarely and their names alone ("Organization", "Projects")
 * do not say which one holds the thing you came for.
 */
export interface OrgRailEntry {
  to: string
  label: string
  hint: string
}

export const ORG_RAIL: OrgRailEntry[] = [
  { to: '/settings', label: 'Settings', hint: 'name, id, control plane' },
  { to: '/settings/integrations', label: 'Integrations', hint: 'github, linear, slack' },
  { to: '/projects', label: 'Projects', hint: 'what the runner watches' },
  { to: '/keys', label: 'Access keys', hint: 'runner and user keys' },
  { to: '/settings/runners', label: 'Runners', hint: 'machines checking in' },
]

/** Whether a path is an organization page, and so should show the rail. */
export function isOrgPath(pathname: string): boolean {
  return ORG_RAIL.some((entry) => pathname === entry.to || pathname.startsWith(`${entry.to}/`))
}

/**
 * Whether an entry should match its path exactly.
 *
 * Only the entries another entry sits *under* need it: `/settings` would
 * otherwise stay lit on Integrations and Runners. Applying `end` to all of
 * them instead leaves the rail with nothing lit on a child page like
 * `/projects/new` — you are plainly in Projects, and the rail said you were
 * nowhere. Derived rather than hand-flagged so adding a nested entry cannot
 * reintroduce either half of that.
 */
export function matchesExactly(entry: OrgRailEntry): boolean {
  return ORG_RAIL.some((other) => other.to.startsWith(`${entry.to}/`))
}

export function OrgRail(): ReactNode {
  const { session } = useSession()

  return (
    <nav className="px-orgrail" aria-label="Organization">
      <div className="px-orgrail__group">
        <span className="px-navgroup__label">{session?.me.org.name ?? 'organization'}</span>
        <div className="px-orgrail__items">
          {ORG_RAIL.map((entry) => (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={matchesExactly(entry)}
              className="px-railitem"
            >
              <span className="px-railitem__label">{entry.label}</span>
              <span className="px-railitem__hint">{entry.hint}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  )
}
