import type { ReactNode } from 'react'
import { Text } from '@16-bits-design/ui/typography'
import { API_URL } from '../config.js'
import { useSession } from '../lib/session.js'
import { PageHeader } from '../components/PageHeader.js'
import { Panel, Section } from '../components/Panel.js'

/**
 * The organization itself.
 *
 * This page used to carry Slack and the runner table as well. Both moved when
 * the organization rail arrived — Slack to Integrations, beside the tracker
 * credentials it belongs with, and the runners to their own page — leaving
 * this as what its title claims: facts about the organization you are signed
 * in to.
 */
export function Settings(): ReactNode {
  const { session } = useSession()

  return (
    <>
      <PageHeader title="Settings" parent={{ label: 'Overview', to: '/' }} />
      <Panel caption={`${session?.me.org.name ?? 'Organization'} · ${API_URL}`}>
        <div className="px-panel__body">
          <Section title="Organization">
            <dl className="px-kv">
              <dt>Name</dt>
              <dd>{session?.me.org.name ?? '—'}</dd>
              <dt>Id</dt>
              <dd>
                <code>{session?.me.org.id ?? '—'}</code>
              </dd>
              <dt>Control plane</dt>
              <dd>
                <code>{API_URL}</code>
              </dd>
              <dt>Signed in with</dt>
              <dd>
                {session?.me.key.name ?? 'a user key'} (<code>{session?.me.key.prefix}…</code>)
              </dd>
            </dl>
            <Text size="caption" tone="muted">
              The organization name is set when it is created with <code>org-cli.js</code>. There is
              no endpoint to rename it yet.
            </Text>
          </Section>
        </div>
      </Panel>
    </>
  )
}
