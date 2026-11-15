import { useEffect, useState, type ReactNode } from "react";
import { apiRequest, queryClient, setCsrf } from "./lib/queryClient";
type Status = { enabled: boolean; authenticated: boolean; username?: string; csrf?: string };
export function AccessGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accept = (s: Status) => { setCsrf(s.csrf || ""); setStatus(s); };
  useEffect(() => {
    const check = () => { apiRequest("GET", "/api/auth/status").then(r => r.json()).then(accept).catch(e => setError(e.message)); };
    const expired = () => {
      setCsrf(""); queryClient.clear(); setStatus({ enabled: true, authenticated: false });
      setError("Your session ended. Sign in again.");
    };
    check();
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("relay-signed-out", expired);
    return () => { clearInterval(timer); window.removeEventListener("relay-signed-out", expired); };
  }, []);
  if (status?.authenticated) return <>
    {status.enabled && <div className="access-owner"><span>{status.username}</span>
      <button className="button secondary" data-testid="button-sign-out" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          await apiRequest("POST", "/api/auth/logout");
          queryClient.clear(); accept({ enabled: true, authenticated: false });
        } catch (e: any) { setError(e.message); }
        finally { setBusy(false); }
      }}>Sign out</button>{error && <span role="alert">{error}</span>}</div>}
    {children}
  </>;
  return <main className="access-page"><form className="access-form" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError("");
    try { const r = await apiRequest("POST", "/api/auth/login", { username, password }); setPassword(""); accept(await r.json()); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }}>
    <div className="eyebrow">RELAY · PRIVATE WORKSPACE</div><h1>Sign in</h1>
    <p>Use the owner account configured on the PC running Relay. This is separate from your GitHub account.</p>
    {!status ? <p>Checking access…</p> : <>
      <label htmlFor="access-user">Username</label>
      <input id="access-user" data-testid="input-login-user" autoComplete="username" required maxLength={64} value={username} onChange={e => setUsername(e.target.value)}/>
      <label htmlFor="access-pass">Password</label>
      <input id="access-pass" data-testid="input-login-password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)}/>
      <button className="button primary" data-testid="button-sign-in" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </>}
    {error && <div role="alert" className="error-banner">{error}</div>}
  </form></main>;
}
