import type { ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { api } from '../api/endpoints.js'
import { useResource } from '../lib/useResource.js'
import { isOrgPath, OrgRail } from './OrgRail.js'
import { Sidebar } from './Sidebar.js'

/**
 * The signed-in frame.
 *
 * Runners, routes and agents load here rather than in each screen: the sidebar
 * shows all three, they change rarely, and fetching them per screen would mean
 * the counts flicker on every navigation. Runners poll because "is the Mac Mini
 * still there" is the one fact that goes stale while you watch it.
 */
export function AppShell(): ReactNode {
  const { pathname } = useLocation()
  const runners = useResource((key, signal) => api.runners(key, signal), [], { pollMs: 30_000 })
  // Polled, not loaded once: the counts sit beside a screen that can create and
  // delete the very things being counted, and a nav that disagrees with the
  // table next to it reads as a bug.
  const routes = useResource((key, signal) => api.routes(key, signal), [], { pollMs: 30_000 })
  const agents = useResource((key, signal) => api.agents(key, signal), [], { pollMs: 60_000 })

  return (
    <div className="px-shell">
      <Sidebar
        runners={runners.data}
        counts={{ Routes: routes.data?.length, Agents: agents.data?.length }}
      />
      {/*
       * Mounted only on organization pages, matching the design's
       * `showOrgRail`. Rendering it always would put a column of settings
       * links beside the run list, which is the surface it was added to keep
       * uncluttered.
       */}
      {isOrgPath(pathname) ? <OrgRail /> : null}
      <main className="px-main">
        <Outlet />
      </main>
    </div>
  )
}
