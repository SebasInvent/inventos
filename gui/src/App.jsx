import { useEffect, useMemo, useState } from 'react';
import { getRecipes, getPlan, streamApply } from './api.js';

const ICON = { preflight: '◆', upload: '↑', provision: '▦', deploy: '▸', converge: '∴', warn: '!' };

export function App() {
  const [recipes, setRecipes] = useState([]);
  const [step, setStep] = useState('pick');        // pick | config | deploy
  const [recipe, setRecipe] = useState(null);
  const [domain, setDomain] = useState('cliente.com');
  const [mode, setMode] = useState('dry');          // dry | local | ssh
  const [host, setHost] = useState('root@');

  useEffect(() => { getRecipes().then(setRecipes).catch(() => setRecipes([])); }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><svg className="mark" viewBox="0 0 158 263" fill="currentColor" aria-hidden="true"><rect y="48" width="57" height="215" rx="28.5" /><circle cx="117" cy="41" r="41" /></svg><b>INVENT</b>OS</div>
        <div className="tag">instalador · local</div>
      </header>

      <div className="stepper">
        {['Elegí', 'Configurá', 'Desplegá'].map((s, i) => (
          <div key={s} className={'st ' + (['pick', 'config', 'deploy'][i] === step ? 'on' : '')}>
            <span className="stn">{i + 1}</span>{s}
          </div>
        ))}
      </div>

      <main className="main">
        {step === 'pick' && (
          <Pick recipes={recipes} onPick={(r) => { setRecipe(r); setStep('config'); }} />
        )}
        {step === 'config' && recipe && (
          <Config
            recipe={recipe} domain={domain} setDomain={setDomain}
            mode={mode} setMode={setMode} host={host} setHost={setHost}
            onBack={() => setStep('pick')} onNext={() => setStep('deploy')}
          />
        )}
        {step === 'deploy' && recipe && (
          <Deploy
            recipe={recipe} domain={domain} mode={mode} host={host}
            onBack={() => setStep('config')}
          />
        )}
      </main>
    </div>
  );
}

function Pick({ recipes, onPick }) {
  return (
    <section className="pane">
      <h1>¿Qué stack querés levantar?</h1>
      <p className="lede">Recetas curadas y endurecidas. Elegí una — el motor resuelve las dependencias.</p>
      <div className="grid">
        {recipes.map((r) => (
          <button key={r.id} className="card" onClick={() => onPick(r)}>
            <div className="cardname">{r.name}</div>
            <div className="cardtag">{r.tagline}</div>
            <div className="cardapps">{r.apps.join(' · ')}</div>
          </button>
        ))}
        {recipes.length === 0 && <div className="muted">Cargando recetas…</div>}
      </div>
    </section>
  );
}

function Config({ recipe, domain, setDomain, mode, setMode, host, setHost, onBack, onNext }) {
  const modes = [
    { id: 'dry', name: 'Vista previa', desc: 'Muestra el plan exacto sin tocar nada. Seguro.' },
    { id: 'local', name: 'Este equipo', desc: 'Despliega en el Docker local (para probar).' },
    { id: 'ssh', name: 'VPS por SSH', desc: 'Despliega en tu servidor. Deploy real.' },
  ];
  return (
    <section className="pane">
      <h1>{recipe.name}</h1>
      <p className="lede">{recipe.tagline}</p>

      <label className="field">
        <span>Dominio</span>
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="cliente.com" spellCheck={false} />
        <small>Las URLs se arman como <code>studio.{domain || 'tudominio.com'}</code>, etc.</small>
      </label>

      <div className="field">
        <span>Dónde desplegar</span>
        <div className="modes">
          {modes.map((m) => (
            <button key={m.id} className={'mode ' + (mode === m.id ? 'on' : '')} onClick={() => setMode(m.id)}>
              <b>{m.name}</b><small>{m.desc}</small>
            </button>
          ))}
        </div>
      </div>

      {mode === 'ssh' && (
        <label className="field">
          <span>Servidor SSH</span>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="root@1.2.3.4" spellCheck={false} />
          <small>Usa tu llave SSH. Las credenciales nunca salen de este equipo.</small>
        </label>
      )}

      <div className="actions">
        <button className="ghost" onClick={onBack}>← Volver</button>
        <button className="primary" onClick={onNext}>Continuar →</button>
      </div>
    </section>
  );
}

function Deploy({ recipe, domain, mode, host, onBack }) {
  const [plan, setPlan] = useState(null);
  const [phase, setPhase] = useState('planning'); // planning | ready | running | done | error
  const [rows, setRows] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setPhase('planning');
    getPlan(recipe.id, domain).then((p) => {
      if (!alive) return;
      if (p.error) { setError(p.error); setPhase('error'); } else { setPlan(p); setPhase('ready'); }
    }).catch((e) => { if (alive) { setError(String(e)); setPhase('error'); } });
    return () => { alive = false; };
  }, [recipe.id, domain]);

  const secure = useMemo(() => {
    if (!plan) return [];
    const secrets = plan.apps.reduce((n, a) => n + a.secrets.length, 0);
    const auth = plan.apps.flatMap((a) => a.adminAuth);
    const internal = plan.apps.reduce((n, a) => n + a.internalOnly, 0);
    return [
      'TLS automático (Let’s Encrypt) en todas las URLs',
      `${secrets} secretos fuertes generados en el deploy`,
      auth.length ? `Paneles sensibles tras basic-auth (${auth.join(', ')})` : 'Paneles admin con login propio obligatorio',
      `${internal} servicios internos sin puerto al host`,
      'Imágenes con tag fijo — nunca :latest',
    ];
  }, [plan]);

  async function run() {
    setPhase('running'); setRows([]); setReport(null);
    await streamApply({ recipe: recipe.id, domain, mode, host }, (msg) => {
      if (msg.t === 'event') {
        setRows((prev) => applyEvent(prev, msg));
      } else if (msg.t === 'done') {
        setReport(msg.report); setPhase('done');
      } else if (msg.t === 'error') {
        setError(msg.error); setPhase('error');
      }
    }).catch((e) => { setError(String(e)); setPhase('error'); });
  }

  const cta = mode === 'dry' ? 'Ver el plan en vivo' : mode === 'local' ? 'Desplegar en este equipo' : 'Desplegar en el VPS';

  return (
    <section className="pane">
      <h1>{recipe.name} <span className="on-dom">· {domain}</span></h1>

      {phase === 'planning' && <div className="muted">Armando el plan…</div>}
      {phase === 'error' && <div className="err">✗ {error}</div>}

      {plan && (phase === 'ready' || phase === 'running' || phase === 'done') && (
        <>
          <div className="cols">
            <div className="panel">
              <div className="ptitle">URLs</div>
              {plan.apps.flatMap((a) => a.routes.map((r) => (
                <div key={a.id + r.name} className="urlrow">
                  <span className="uname">{a.name}</span>
                  <span className="uurl">https://{r.url.replace(/^https?:\/\//, '')}</span>
                </div>
              )))}
              {plan.apps.every((a) => a.routes.length === 0) && <div className="muted">Sin rutas públicas.</div>}
            </div>
            <div className="panel safe">
              <div className="ptitle">Seguro de fábrica</div>
              {secure.map((s) => <div key={s} className="saferow"><span className="ck">✔</span>{s}</div>)}
            </div>
          </div>

          {phase === 'ready' && (
            <div className="actions">
              <button className="ghost" onClick={onBack}>← Volver</button>
              <button className="primary big" onClick={run}>{cta} →</button>
            </div>
          )}

          {(phase === 'running' || phase === 'done') && (
            <div className="live">
              <div className="ptitle">{phase === 'running' ? 'Desplegando…' : 'Deploy completo'}</div>
              {rows.map((r, i) => (
                <div key={i} className={'liverow ' + r.status}>
                  <span className="lmark">{r.status === 'running' ? <Spinner /> : r.status === 'done' ? '✔' : r.status === 'warn' ? '◆' : '✗'}</span>
                  <span className="lic">{ICON[r.stepKind] ?? '·'}</span>
                  <span className="llabel">{r.label}</span>
                  {r.suffix && <span className="lsuffix">{r.suffix}</span>}
                </div>
              ))}
            </div>
          )}

          {phase === 'done' && report && <Report report={report} mode={mode} onBack={onBack} />}
        </>
      )}
    </section>
  );
}

function Report({ report, mode, onBack }) {
  const creds = report.apps.flatMap((a) => a.credentials.map((c) => ({ app: a.name, ...c })));
  return (
    <div className="reportbox">
      <div className="done-h">✔ Listo</div>
      {mode === 'dry'
        ? <p className="muted">Vista previa: nada se desplegó. Elegí “Este equipo” o “VPS por SSH” para desplegar de verdad.</p>
        : creds.length > 0
          ? (
            <div className="creds">
              <div className="ptitle">Credenciales (se muestran una vez)</div>
              {creds.map((c) => (
                <div key={c.app + c.key} className="credrow">
                  <span className="ckey">{c.app} · {c.key}</span>
                  <code className="cval">{c.value}</code>
                </div>
              ))}
              <p className="muted">Guardadas también en <code>.inventos/&lt;proyecto&gt;/credentials.txt</code> (chmod 600).</p>
            </div>
          )
          : <p className="muted">Deploy completo.</p>}
      <div className="actions"><button className="ghost" onClick={onBack}>← Otra receta</button></div>
    </div>
  );
}

function Spinner() {
  const [f, setF] = useState(0);
  useEffect(() => { const t = setInterval(() => setF((x) => x + 1), 90); return () => clearInterval(t); }, []);
  return <span className="spin">{['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'][f % 8]}</span>;
}

// Reduce un ApplyEvent sobre la lista de filas (sec. → siempre la última fila activa).
function applyEvent(prev, e) {
  if (e.type === 'start') {
    return [...prev, { label: e.label, stepKind: e.stepKind, status: 'running', suffix: '' }];
  }
  const rows = prev.slice();
  const i = rows.length - 1;
  if (i < 0) return rows;
  if (e.type === 'converge') {
    if (e.desired) rows[i] = { ...rows[i], suffix: `${e.running}/${e.desired}` };
  } else if (e.type === 'done' || e.type === 'fail' || e.type === 'warn') {
    rows[i] = { ...rows[i], status: e.type, label: e.label };
  }
  return rows;
}
