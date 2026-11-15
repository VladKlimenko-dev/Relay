export type RemoteAccessForm = {
  username: string; address: string; port: number; password: string; confirmation: string;
  current: string; configured: boolean; confirmEnable: boolean;
};
// Explain client-side blockers without displaying any entered password.
// Server-side address, certificate, current-password and port checks remain authoritative.
export function remoteAccessRequirements(form: RemoteAccessForm): string[] {
  const missing: string[] = [];
  if (!form.address.trim()) missing.push("Enter the public IPv4 address or existing hostname.");
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(form.username)) missing.push("Use a username of 3–64 letters, digits, dots, underscores or hyphens.");
  if (!Number.isInteger(form.port) || form.port < 1024 || form.port > 65535) missing.push("Choose an HTTPS port from 1024 to 65535.");
  if (form.configured && !form.current) missing.push("Enter the current Relay password to change the saved credentials.");
  if (form.password.length < 15 || form.password.length > 256) missing.push("Enter a new Relay password of 15–256 characters.");
  if (!form.confirmation) missing.push("Repeat the new password.");
  else if (form.password !== form.confirmation) missing.push("Make both new-password fields match exactly.");
  if (!form.confirmEnable) missing.push('Tick “Enable HTTPS owner access after restart” to confirm.');
  return missing;
}
