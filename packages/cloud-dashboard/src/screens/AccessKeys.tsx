import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@16-bits-design/ui/badge'
import { Button } from '@16-bits-design/ui/button'
import { Code } from '@16-bits-design/ui/code'
import { Dialog } from '@16-bits-design/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableCellContent,
  TableHead,
  TableHeader,
  TableRow,
} from '@16-bits-design/ui/table'
import { Text } from '@16-bits-design/ui/typography'
import { useToast } from '@16-bits-design/ui/toast'
import { api } from '../api/endpoints.js'
import { useKey, useSession } from '../lib/session.js'
import { useResource } from '../lib/useResource.js'
import { relativeTime } from '../lib/format.js'
import { EmptyState } from '@16-bits-design/ui/empty-state'
import { ErrorPanel } from '../components/ErrorPanel.js'
import { Spinner } from '@16-bits-design/ui/spinner'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'
import type { ApiKey } from '../api/types.js'

/**
 * Minting and revoking keys.
 *
 * A freshly minted key is shown once, in a panel that stays until dismissed,
 * because the API never returns the plaintext again — a toast that timed out
 * would lose it for good. The key currently signed in with is marked and cannot
 * be revoked from here, since doing so would end the session mid-action and
 * leave no way back in.
 */
export function AccessKeys(): ReactNode {
  const key = useKey()
  const navigate = useNavigate()
  const { session } = useSession()
  const { toast } = useToast()
  const keys = useResource((k, signal) => api.keys(k, signal), [])

  const [revoking, setRevoking] = useState<ApiKey | undefined>(undefined)

  const revoke = async (target: ApiKey): Promise<void> => {
    try {
      await api.revokeKey(key, target.id)
      toast({
        tone: 'success',
        title: 'Key revoked',
        message: `${target.name} stops working immediately.`,
      })
      keys.reload()
    } catch (cause) {
      toast({
        tone: 'danger',
        title: 'Could not revoke the key',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const active = (keys.data ?? []).filter((entry) => !entry.revoked_at)

  return (
    <>
      <PageHeader
        title="Access keys"
        parent={{ label: 'Overview', to: '/' }}
        actions={<Button onClick={() => navigate('/keys/new')}>generate key</Button>}
      />
      <Panel caption="Credentials for runners and for people">
        <div className="px-panel__body">
          <Section title="Active keys" padded={false}>
            {keys.loading ? (
              <Spinner label="Loading keys" />
            ) : keys.error ? (
              <ErrorPanel message={keys.error} onRetry={keys.reload} />
            ) : active.length === 0 ? (
              <EmptyState
                title="No active keys"
                action={
                  <Button size="sm" onClick={() => navigate('/keys/new')}>
                    generate key
                  </Button>
                }
              >
                A key is how a runner and this dashboard authenticate.
              </EmptyState>
            ) : (
              <Table scrollLabel="Access keys" containerClassName="px-tablewrap" minWidth={520}>
                <TableHead>
                  <TableRow>
                    <TableHeader>Name</TableHeader>
                    <TableHeader>Key</TableHeader>
                    <TableHeader>Scope</TableHeader>
                    <TableHeader>Last used</TableHeader>
                    <TableHeader>
                      <span className="px-visually-hidden">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {active.map((entry) => {
                    const isCurrent = entry.id === session?.me.key.id
                    return (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <TableCellContent
                            primary={entry.name}
                            secondary={`created ${relativeTime(entry.created_at)}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Code variant="inline">{entry.prefix}…</Code>
                        </TableCell>
                        <TableCell>
                          <Badge tone={entry.scope === 'runner' ? 'amber' : 'primary'}>
                            {entry.scope}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Text size="small" tone="muted">
                            {relativeTime(entry.last_used_at)}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <div className="px-rowactions">
                            {isCurrent ? (
                              <Badge tone="outline">this session</Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setRevoking(entry)}
                                aria-label={`Revoke key ${entry.name}`}
                              >
                                revoke
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      </Panel>

      <Dialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        tone="danger"
        icon="!"
        title="Revoke this key"
        description="Anything using it starts failing immediately, including a runner mid-poll. This cannot be undone; mint a replacement instead."
        meta={revoking?.name}
        confirmLabel="revoke key"
        cancelLabel="keep it"
        onConfirm={() => {
          if (revoking) {
            void revoke(revoking)
          }
          setRevoking(undefined)
        }}
      />
    </>
  )
}
