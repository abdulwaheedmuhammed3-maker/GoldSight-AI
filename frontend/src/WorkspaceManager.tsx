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

function readWorkspaces(): Workspace[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (Array.isArray(parsed) && parsed.length) return parsed
  } catch { /* use starter workspace */ }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults))
  return defaults
}

export default function WorkspaceManager() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(readWorkspaces)
  const [activeId, setActiveId] = useState(() => localStorage.getItem('tradesight-active-workspace-v1') || 'personal')
  const [newName, setNewName] = useState('')
  const [notice, setNotice] = useState('')

  const active = workspaces.find(item => item.id === activeId) || workspaces[0]

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces))
    if (active) localStorage.setItem('tradesight-active-workspace-v1', active.id)
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

  return <section className="panel" style={{marginTop:16}}>
    <div className="panel-head"><div><p className="eyebrow">PERSONAL ENVIRONMENTS</p><h2>Workspaces</h2><p className="muted">Separate trading profiles under one TradeSight account.</p></div><span className="history-count">{workspaces.length} WORKSPACE{workspaces.length === 1 ? '' : 'S'}</span></div>
    <div className="settings-group">
      <span>Active workspace</span>
      <div className="settings-actions">
        {workspaces.map(item => <button key={item.id} className={item.id === active.id ? 'selected' : ''} onClick={() => { setActiveId(item.id); setNotice(`Switched to ${item.name}.`) }}>{item.name}</button>)}
      </div>
    </div>
    <div className="settings-group">
      <span>Workspace profile</span>
      <label className="muted" htmlFor="workspace-name">Name</label>
      <input id="workspace-name" value={active.name} onChange={event => updateActive({name:event.target.value})} maxLength={48} />
      <label className="muted" htmlFor="workspace-broker">Broker</label>
      <select id="workspace-broker" value={active.broker} onChange={event => updateActive({broker:event.target.value})}>
        <option>Not connected</option><option>Exness</option><option>Headway</option><option>Other</option>
      </select>
      <label className="muted" htmlFor="workspace-account">Account environment</label>
      <select id="workspace-account" value={active.accountType} onChange={event => updateActive({accountType:event.target.value as Workspace['accountType']})}>
        <option>Demo</option><option>Live</option>
      </select>
      <label className="muted" htmlFor="workspace-risk">Preferred risk per trade: {active.riskPct}%</label>
      <input id="workspace-risk" type="range" min="0.25" max="2" step="0.25" value={active.riskPct} onChange={event => updateActive({riskPct:Number(event.target.value)})} />
      <p className="score-note">Preference only. This setting does not authorize or execute live orders. The eventual execution service must enforce its own risk limit.</p>
      <span>Markets</span>
      <div className="settings-actions">
        {(['XAUUSD','BTCUSD','EURUSD','GBPUSD'] as const).map(symbol => <button key={symbol} className={active.symbols.includes(symbol) ? 'selected' : ''} onClick={() => updateActive({symbols:active.symbols.includes(symbol) ? active.symbols.filter(item => item !== symbol) : [...active.symbols, symbol]})}>{symbol}</button>)}
      </div>
    </div>
    <div className="settings-group">
      <span>Create another workspace</span>
      <input value={newName} onChange={event => setNewName(event.target.value)} placeholder="e.g. Long-term account" maxLength={48} />
      <div className="settings-actions"><button onClick={createWorkspace}>＋ Create workspace</button><button onClick={deleteWorkspace} disabled={workspaces.length === 1}>Delete active workspace</button></div>
    </div>
    {notice && <p className="muted" role="status">{notice}</p>}
    <p className="score-note">Initial local prototype: workspaces are saved on this device only. Cloud sync, login ownership, separate MT5 credentials, signals, notifications and trade histories are not connected yet.</p>
  </section>
}
