import { useEffect, useState } from 'react'

type Workspace = {
  id: string
  name: string
  broker: string
  accountType: 'Demo' | 'Live'
  riskPct: number
  symbols: string[]
  createdAt: string
}

const STORAGE_KEY = 'tradesight-workspaces-v1'
const defaults: Workspace[] = [
  { id: 'personal', name: 'Personal Trading', broker: 'Exness', accountType: 'Demo', riskPct: 2, symbols: ['XAUUSD', 'BTCUSD'], createdAt: new Date().toISOString() },
]

function safeGet(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}

function safeSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* storage may be disabled or full */ }
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Workspace>
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string'
    && typeof item.broker === 'string'
    && (item.accountType === 'Demo' || item.accountType === 'Live')
    && typeof item.riskPct === 'number' && Number.isFinite(item.riskPct)
    && Array.isArray(item.symbols) && item.symbols.every(symbol => typeof symbol === 'string')
    && typeof item.createdAt === 'string'
}

function readWorkspaces(): Workspace[] {
  try {
    const parsed: unknown = JSON.parse(safeGet(STORAGE_KEY) || 'null')
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(isWorkspace)
      if (valid.length) return valid
    }
  } catch { /* use starter workspace */ }
  safeSet(STORAGE_KEY, JSON.stringify(defaults))
  return defaults
}

export default function WorkspaceManager() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(readWorkspaces)
  const [activeId, setActiveId] = useState(() => safeGet('tradesight-active-workspace-v1') || 'personal')
  const [newName, setNewName] = useState('')
  const [notice, setNotice] = useState('')
  const active = workspaces.find(item => item.id === activeId) || workspaces[0]

  useEffect(() => {
    safeSet(STORAGE_KEY, JSON.stringify(workspaces))
    if (active) safeSet('tradesight-active-workspace-v1', active.id)
  }, [workspaces, active])

  const updateActive = (patch: Partial<Workspace>) => {
    setWorkspaces(items => items.map(item => item.id === active.id ? { ...item, ...patch } : item))
  }
  const createWorkspace = () => {
    const name = newName.trim()
    if (!name) { setNotice('Enter a workspace name first.'); return }
    const workspace: Workspace = {
      id: crypto.randomUUID(), name, broker: 'Not connected', accountType: 'Demo',
      riskPct: 1, symbols: ['XAUUSD'], createdAt: new Date().toISOString(),
    }
    setWorkspaces(items => [...items, workspace])
    setActiveId(workspace.id)
    setNewName('')
    setNotice('Workspace created on this device.')
  }
  const deleteWorkspace = () => {
    if (workspaces.length === 1) { setNotice('Keep at least one workspace.'); return }
    if (!window.confirm(`Delete "${active.name}" from this device? Its local workspace preferences will be lost.`)) return
    const remaining = workspaces.filter(item => item.id !== active.id)
    setWorkspaces(remaining)
    setActiveId(remaining[0].id)
    setNotice('Workspace removed from this device.')
  }
  const toggleSymbol = (symbol: string) => {
    const selected = active.symbols.includes(symbol)
    updateActive({ symbols: selected ? active.symbols.filter(item => item !== symbol) : [...active.symbols, symbol] })
  }

  return <section className="panel workspace-panel" aria-labelledby="workspace-title">
    <div className="workspace-heading">
      <div className="workspace-heading-copy">
        <p className="eyebrow">PERSONAL ENVIRONMENTS</p>
        <h2 id="workspace-title">Workspaces</h2>
        <p className="muted">Keep each trading profile organised on this device.</p>
      </div>
      <span className="workspace-count">{workspaces.length} {workspaces.length === 1 ? 'WORKSPACE' : 'WORKSPACES'}</span>
    </div>

    <section className="workspace-section" aria-label="Choose active workspace">
      <div className="workspace-section-heading"><div><b>Your environments</b><small>Select the profile you want to work in.</small></div></div>
      <div className="workspace-switcher">
        {workspaces.map(item => <button type="button" key={item.id} className={item.id === active.id ? 'workspace-choice active' : 'workspace-choice'} aria-pressed={item.id === active.id} onClick={() => { setActiveId(item.id); setNotice(`Switched to ${item.name}.`) }}>
          <span className="workspace-choice-icon" aria-hidden="true">▦</span>
          <span className="workspace-choice-text"><b>{item.name}</b><small>{item.broker} · {item.accountType}</small></span>
          {item.id === active.id && <span className="workspace-active-mark">ACTIVE</span>}
        </button>)}
      </div>
    </section>

    <section className="workspace-section" aria-label="Workspace profile">
      <div className="workspace-section-heading"><div><b>Workspace profile</b><small>Set the broker and preferences for this environment.</small></div></div>
      <div className="workspace-fields">
        <label className="workspace-field workspace-field-wide"><span>Workspace name</span><input id="workspace-name" value={active.name} onChange={event => updateActive({name:event.target.value})} maxLength={48} placeholder="Name this workspace" /></label>
        <label className="workspace-field"><span>Broker</span><select id="workspace-broker" value={active.broker} onChange={event => updateActive({broker:event.target.value})}><option>Not connected</option><option>Exness</option><option>Headway</option><option>Other</option></select></label>
        <label className="workspace-field"><span>Account environment</span><select id="workspace-account" value={active.accountType} onChange={event => updateActive({accountType:event.target.value as Workspace['accountType']})}><option>Demo</option><option>Live</option></select></label>
      </div>
    </section>

    <section className="workspace-section" aria-label="Risk preference">
      <div className="workspace-risk-head"><div><b>Preferred risk per trade</b><small>Risk preference for this workspace</small></div><strong>{active.riskPct.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')}%</strong></div>
      <input className="workspace-risk-slider" id="workspace-risk" aria-label="Preferred risk per trade" type="range" min="0.25" max="2" step="0.25" value={active.riskPct} onChange={event => updateActive({riskPct:Number(event.target.value)})} />
      <div className="workspace-range-labels"><span>0.25% · Conservative</span><span>2% · Higher risk</span></div>
      <p className="workspace-helper">Preference only. This does not authorise or execute live orders. Any future execution service must enforce its own risk limits.</p>
    </section>

    <section className="workspace-section" aria-label="Markets">
      <div className="workspace-section-heading"><div><b>Markets in this workspace</b><small>Choose the instruments shown for this profile.</small></div></div>
      <div className="workspace-markets">
        {(['XAUUSD','BTCUSD','EURUSD','GBPUSD'] as const).map(symbol => <button type="button" key={symbol} className={active.symbols.includes(symbol) ? 'workspace-market selected' : 'workspace-market'} aria-pressed={active.symbols.includes(symbol)} onClick={() => toggleSymbol(symbol)}><span>{active.symbols.includes(symbol) ? '✓' : '+'}</span>{symbol}</button>)}
      </div>
    </section>

    <section className="workspace-create">
      <div><b>Create another workspace</b><small>Add a separate profile for another account or strategy.</small></div>
      <div className="workspace-create-controls"><input aria-label="New workspace name" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') createWorkspace() }} placeholder="e.g. Long-term account" maxLength={48} /><button type="button" className="workspace-create-button" onClick={createWorkspace}>＋ Create workspace</button></div>
    </section>

    <div className="workspace-footer">
      <p className="workspace-notice" role="status">{notice}</p>
      <button type="button" className="workspace-delete" onClick={deleteWorkspace} disabled={workspaces.length === 1}>Delete active workspace</button>
    </div>
    <p className="workspace-storage-note"><span aria-hidden="true">ⓘ</span> Workspaces are currently stored on this device only. Cloud sync, login ownership, separate MT5 credentials, signals, notifications and trade histories are not connected yet.</p>
  </section>
}
