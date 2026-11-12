import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const WALL_PREFIX = 'https://wall.moonetix.com/';

// Fetches the signed link for the current user. A link fetched for a previous user is never returned.
function useOfferwallLink(userId) {
  const [link, setLink] = useState(null);
  useEffect(() => {
    if (!userId) return undefined;
    let ignore = false;
    api.offerwallLink()
      .then(({ url }) => {
        if (!ignore && typeof url === 'string' && url.startsWith(WALL_PREFIX)) setLink({ userId, url });
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [userId]);
  return link && link.userId === userId ? link.url : null;
}

function AuthForm({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [age, setAge] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') await api.signup(email, password, age);
      else await api.login(email, password);
      onSignedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <h1>{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
      <label>
        Email
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          minLength={mode === 'signup' ? 10 : undefined}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {mode === 'signup' && (
        <label className="check">
          <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} required />
          I am 16 or older. Under 18, I have a parent&apos;s permission.
        </label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
      <button type="button" className="link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}>
        {mode === 'signup' ? 'I already have an account' : 'Create an account'}
      </button>
    </form>
  );
}

function History({ rows }) {
  if (rows.length === 0) return <p className="muted">No rewards yet. Coins usually arrive a few minutes after an offer is confirmed.</p>;
  return (
    <table>
      <thead>
        <tr><th>Date</th><th>Offer</th><th className="num">Coins</th><th>Status</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{new Date(r.at * 1000).toLocaleString()}</td>
            <td>{r.offer || 'Offer'}</td>
            <td className="num">{r.state === 'reversed' ? `-${r.amount}` : `+${r.amount}`}</td>
            <td>{r.state === 'reversed' ? 'Reversed' : 'Credited'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Dashboard({ me, onSignedOut }) {
  const link = useOfferwallLink(me.user.id);
  const [embedded, setEmbedded] = useState(false);

  return (
    <main>
      <header className="bar">
        <span className="muted">{me.user.email}</span>
        <button type="button" className="link" onClick={() => api.logout().finally(onSignedOut)}>Sign out</button>
      </header>

      <section className="card">
        <p className="muted">Your balance</p>
        <p className="balance">{me.balance} <span>coins</span></p>
        <div className="actions">
          {link ? (
            // embed.js opens links marked data-moonetix-open in a pop-up. Without the script, it is a normal link.
            <a className="button" href={link} data-moonetix-open="" rel="noopener">Earn coins</a>
          ) : (
            <span className="button disabled" aria-disabled="true">Loading offers</span>
          )}
          <button type="button" className="secondary" disabled={!link} onClick={() => setEmbedded(!embedded)}>
            {embedded ? 'Hide offers' : 'Show offers on this page'}
          </button>
        </div>
      </section>

      {embedded && link && (
        <iframe key={link} title="Offerwall" src={link} className="wall" />
      )}

      <section className="card">
        <h2>Reward history</h2>
        <History rows={me.history} />
      </section>
    </main>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined);

  const refresh = useCallback(() => {
    api.me().then(setMe).catch((err) => setMe(err.status === 401 ? null : undefined));
  }, []);

  useEffect(() => {
    refresh();
    // Rewards arrive by postback while the user is on the offerwall. Reload when they come back.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  if (me === undefined) return <main><p className="muted">Loading</p></main>;
  if (me === null) return <main><AuthForm onSignedIn={refresh} /></main>;
  return <Dashboard me={me} onSignedOut={() => setMe(null)} />;
}
