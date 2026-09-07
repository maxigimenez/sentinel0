import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from '@16-bits-design/ui/theme'
import { ToastProvider } from '@16-bits-design/ui/toast'
import { AppShell } from './components/AppShell.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { SessionProvider, useSession } from './lib/session.js'
import { AccessKeys } from './screens/AccessKeys.js'
import { Agents } from './screens/Agents.js'
import { Integrations } from './screens/Integrations.js'
import { KeyNew } from './screens/KeyNew.js'
import { Login } from './screens/Login.js'
import { Overview } from './screens/Overview.js'
import { ProjectNew } from './screens/ProjectNew.js'
import { Projects } from './screens/Projects.js'
import { RouteEdit } from './screens/RouteEdit.js'
import { RouteList } from './screens/RouteList.js'
import { RouteNew } from './screens/RouteNew.js'
import { RunDetail } from './screens/RunDetail.js'
import { RunList } from './screens/RunList.js'
import { Runners } from './screens/Runners.js'
import { Settings } from './screens/Settings.js'

function Authenticated(): ReactNode {
  const { session, restoring } = useSession()

  // Restoring is a distinct state from signed-out: a stored key is being
  // re-verified, and rendering the login form underneath it would flash a form
  // the user is about to be taken past.
  if (restoring) {
    return <Spinner label="Restoring your session" />
  }
  if (!session) {
    return <Login />
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Overview />} />
        <Route path="/runs" element={<RunList />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/routes" element={<RouteList />} />
        <Route path="/routes/new" element={<RouteNew />} />
        <Route path="/routes/:id/edit" element={<RouteEdit />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/new" element={<ProjectNew />} />
        <Route path="/keys" element={<AccessKeys />} />
        <Route path="/keys/new" element={<KeyNew />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/integrations" element={<Integrations />} />
        <Route path="/settings/runners" element={<Runners />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export function App(): ReactNode {
  return (
    // ToastProvider sits inside ThemeProvider so portalled toasts and dialogs
    // inherit the theme rather than rendering unthemed at the document root.
    //
    // "noir" is not a built-in theme. The library takes any name and writes
    // it to data-bits-theme; src/theme-noir.css defines what it means.
    //
    // ThemeProvider renders a real div, which would otherwise sit between #root
    // and the app with an auto height — collapsing every percentage height
    // below it. px-root re-establishes the chain.
    <ThemeProvider theme="noir" className="px-root">
      <ToastProvider>
        <SessionProvider>
          <BrowserRouter>
            <Authenticated />
          </BrowserRouter>
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
