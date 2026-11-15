import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { apiRequest } from "./lib/queryClient";
import { remoteAccessRequirements } from "@shared/remoteAccessValidation";

type Status = {
  computerName: string; platform: string; localSetupAllowed: boolean; localAddresses: string[];
  configured: boolean; active: boolean; username: string; publicOrigin: string; port: number;
  pendingRestart: boolean; certificate: { fingerprint: string; expires: string } | null;
};
type PublicIp = { ip: string | null; stale: boolean; checkedAt: string; error?: string };
export function RemoteSettings() {
  const { data: status, error: statusError, refetch } = useQuery<Status>({
    queryKey: ["/api/remote/status"], staleTime: 0, refetchOnMount: "always",
  });
  const { data: publicIp, isFetching: checkingIp, error: ipError, refetch: refreshIp } = useQuery<PublicIp>({
    queryKey: ["/api/remote/public-ip"],
    queryFn: async () => (await apiRequest("GET", "/api/remote/public-ip?refresh=1")).json(),
    staleTime: 300_000, refetchOnMount: "always",
  });
  const [username, setUsername] = useState(""), [address, setAddress] = useState(""), [port, setPort] = useState(5443);
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState(""), [current, setCurrent] = useState("");
  const [confirmEnable, setConfirmEnable] = useState(false), [renew, setRenew] = useState(false);
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [error, setError] = useState("");
  const initialized = useRef(false), editedAddress = useRef(false);
  const requirements = remoteAccessRequirements({ username, address, port, password, confirmation, current,
    configured: !!status?.configured, confirmEnable });
  useEffect(() => {
    if (!status || initialized.current) return;
    initialized.current = true; setUsername(status.username); setPort(status.port);
    if (status.publicOrigin) setAddress(new URL(status.publicOrigin).hostname);
  }, [status]);
  useEffect(() => {
    if (status && !status.configured && !editedAddress.current && publicIp?.ip && !publicIp.stale) setAddress(publicIp.ip);
  }, [status, publicIp]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || requirements.length) return;
    setBusy(true); setError(""); setNote("");
    try {
      const result = await (await apiRequest("POST", "/api/remote/settings", {
        username: username.trim(), address: address.trim(), port, password, confirmPassword: confirmation,
        currentPassword: current, confirmEnable, renewCertificate: renew,
      })).json();
      setNote(result.message); setPassword(""); setConfirmation(""); setCurrent(""); setConfirmEnable(false); setRenew(false);
      await refetch();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  const changedIp = status?.publicOrigin && publicIp?.ip && !publicIp.stale &&
    new URL(status.publicOrigin).hostname !== publicIp.ip && /^\d+\./.test(new URL(status.publicOrigin).hostname);
  return <section className="settings-section">
    <div className="settings-section-title"><ShieldCheck size={19}/><h2>Remote access</h2></div>
    {statusError && <div role="alert" className="error-banner">{(statusError as Error).message}</div>}
    <div className="connection-row">
      <div className="grow"><span className="field-label">RELAY COMPUTER</span><code data-testid="remote-computer">{status?.computerName || "Loading…"}</code>
        {!!status?.localAddresses.length && <p className="small-muted">Local network: {status.localAddresses.join(", ")}</p>}</div>
      <div className="grow"><span className="field-label">PUBLIC IPv4 {publicIp?.stale ? "(LAST KNOWN)" : ""}</span>
        <code data-testid="remote-public-ip">{publicIp?.ip || (checkingIp ? "Checking…" : "Unavailable")}</code>
        {publicIp?.checkedAt && <p className="small-muted">Checked {new Date(publicIp.checkedAt).toLocaleString()}</p>}</div>
      <button type="button" data-testid="refresh-public-ip" className="button secondary" disabled={checkingIp} onClick={() => refreshIp()}>
        {checkingIp ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}Refresh IP</button>
    </div>
    {(publicIp?.error || ipError) && <div role="alert" className="error-banner">{publicIp?.error || (ipError as Error).message}</div>}
    <p className="settings-note">Detected from the PC running Relay, not your visiting browser, using ipify. This is the connection's public address, not a unique PC identifier; a VPN or shared ISP address may prevent direct inbound connections. Checking it does not test whether Relay is reachable from the internet.</p>
    {changedIp && <div role="alert" className="error-banner">The detected IP differs from the configured address. Verify your connection, then update the address and certificate if your public IP changed.</div>}
    {status && <div role="status" className={status.pendingRestart ? "error-banner" : "success-banner"}>
      {status.pendingRestart ? "Saved changes are pending. Restart Relay to activate the new login/address." :
        status.active ? "HTTPS owner login is enabled. Internet reachability has not been tested." : "Remote access is not enabled. Relay currently accepts local connections only."}
    </div>}
    {status?.publicOrigin && <div className="connection-row"><div className="grow"><span className="field-label">REMOTE HTTPS ADDRESS {status.pendingRestart ? "(AFTER RESTART)" : ""}</span>
      <code data-testid="remote-url" style={{ overflowWrap: "anywhere" }}>{status.publicOrigin}</code></div>
      <span className="small-muted">Username: {status.username}</span></div>}
    {status?.localSetupAllowed ? <form onSubmit={save}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="connection-row">
          <div className="grow"><label className="field-label" htmlFor="remote-address">PUBLIC IPv4 / EXISTING HOSTNAME</label>
            <input id="remote-address" required maxLength={253} value={address} onChange={e => { editedAddress.current = true; setAddress(e.target.value); }}/></div>
          <div><label className="field-label" htmlFor="remote-port">HTTPS PORT</label>
            <input id="remote-port" type="number" required min={1024} max={65535} value={port} onChange={e => setPort(Number(e.target.value))}/></div>
        </div>
        <div className="connection-row">
          <div className="grow"><label className="field-label" htmlFor="remote-user">RELAY USERNAME</label>
            <input id="remote-user" autoComplete="username" required minLength={3} maxLength={64} pattern="[A-Za-z0-9._\-]+" value={username} onChange={e => setUsername(e.target.value)}/></div>
          {status.configured && <div className="grow"><label className="field-label" htmlFor="remote-current">CURRENT RELAY PASSWORD</label>
            <input id="remote-current" type="password" autoComplete="current-password" required maxLength={256} value={current} onChange={e => setCurrent(e.target.value)}/></div>}
        </div>
        <div className="connection-row">
          <div className="grow"><label className="field-label" htmlFor="remote-password">NEW RELAY PASSWORD (15+ CHARACTERS)</label>
            <input id="remote-password" type="password" autoComplete="new-password" required minLength={15} maxLength={256} value={password} onChange={e => setPassword(e.target.value)}/></div>
          <div className="grow"><label className="field-label" htmlFor="remote-confirm">REPEAT PASSWORD</label>
            <input id="remote-confirm" type="password" autoComplete="new-password" required minLength={15} maxLength={256} value={confirmation} onChange={e => setConfirmation(e.target.value)}/></div>
        </div>
        {confirmation && confirmation !== password && <p role="alert" className="small-muted">Passwords do not match.</p>}
        {status.configured && <label className="check"><input type="checkbox" checked={renew} onChange={e => setRenew(e.target.checked)}/>Generate a new self-signed certificate (requires trusting it again; IPv4 only)</label>}
        <label className="check"><input type="checkbox" required checked={confirmEnable} onChange={e => setConfirmEnable(e.target.checked)}/>Enable HTTPS owner access after restart. This account controls all Relay projects and connected GitHub access.</label>
        <div id="remote-save-requirements" className="settings-note" role="status" aria-live="polite">
          {busy ? "Saving remote access and preparing the HTTPS certificate…" : requirements.length ? <><p>Before you can save:</p><ul style={{ paddingLeft: 20, listStyle: "disc" }}>{requirements.map(reason => <li key={reason}>{reason}</li>)}</ul></> : "All form requirements are met. You can save remote access."}
        </div>
        <div className="connection-row"><button data-testid="save-remote-access" aria-describedby="remote-save-requirements" className="button primary" disabled={busy || requirements.length > 0}>
          {busy ? <LoaderCircle size={15} className="spin"/> : <Globe size={15}/>}Save remote access</button></div>
      </fieldset>
    </form> : status && <p className="settings-note">To create or change this login, open Settings locally on the Windows PC running Relay using its localhost address. Credentials cannot be changed from a remote connection.</p>}
    {error && <div role="alert" className="error-banner">{error}</div>}
    {note && <div role="status" className="success-banner">{note}</div>}
    {status?.certificate && <div className="settings-note">
      <a href="/api/remote/certificate" download="relay-public.cer">Download public certificate</a>
      <p>Expires: {status.certificate.expires}. SHA-256 fingerprint: <code style={{ overflowWrap: "anywhere" }}>{status.certificate.fingerprint}</code></p>
    </div>}
    <p className="settings-note">The password is hashed, never displayed or returned. Use a separate password, not your GitHub token or Windows password. Settings prepare the HTTPS certificate and save the login; restart with start-relay.cmd to apply them.</p>
    <details className="settings-note"><summary>Before connecting from the internet</summary>
      <ol>
        <li>Transfer only relay-public.cer to your own client devices. Verify the fingerprint shown here and trust that public certificate before entering your login. Never share a .pfx file or the secrets folder; do not bypass browser certificate warnings.</li>
        <li>Allow inbound TCP {status?.port || port} in Windows Firewall and forward the same TCP port on your router to this PC's local IPv4 address. Relay does not change these rules automatically. Shared ISP NAT may require a public address from your ISP or a private VPN solution.</li>
        <li>Restart Relay and open the configured HTTPS address from another network. Do not expose HTTP 5000, llama.cpp 8080 or Ollama 11434. Public IP detection alone does not establish connectivity.</li>
      </ol>
    </details>
  </section>;
}
