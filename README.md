# Relay: local-first AI development studio

Relay coordinates a chat-driven software team: orchestrator, architect, developer, test engineer, data specialist, and reviewer. This is a single-user MVP, not a trained model or a claim of Opus 5.5 parity.

## Run locally

Requirements: Node.js 20.19+ (or 22.12+), npm, and a working local Ollama installation.

```sh
npm ci
npm run dev
```

Open `http://localhost:5000`. Demo mode works without Ollama.

For real inference, install models with Ollama, set each agent's tag under Agents, then select Local Ollama in Settings. The default endpoint is `http://127.0.0.1:11434`. The backend, not your browser, calls Ollama. A hosted preview cannot reach Ollama on your PC.

To use a trusted Ollama server elsewhere, configure `OLLAMA_HOST` in the server environment before startup. Do not expose the app or Ollama to untrusted networks. No authentication or multi-user isolation is implemented.

```sh
npm run build
npm start
```

## Implemented

- Chat creates a plan; a separate explicit approval starts specialist calls.
- Demo runtime produces fixed, labeled examples. Ollama runtime generates plans and specialist outputs using the configured models.
- Agents run sequentially with dependency-ordered handoffs. Model unloading (`keep_alive: 0`) limits concurrent model memory use.
- Stop a run; preserve completed outputs. Failed or interrupted runs surface errors.
- Source imports, projects, agent settings, run history, and evaluation records persist in SQLite (`data.db`).
- Export complete runs or individual outputs as Markdown; manual evaluation results as CSV.
- English and Russian input. The model determines output-language quality; the UI is English.

## Windows quick start

1. Intel Arc Pro B60: install the newest Arc Pro driver from intel.com and enable Resizable BAR (ReBAR) and Above 4G Decoding in BIOS.
2. Unzip to a drive with at least 30 GB free.
3. Double-click `setup.cmd`. It checks and installs, if missing: Node.js 22.13+, Python 3.10+ with pip and `huggingface_hub`, Git, llama.cpp (`tools\llama.cpp`; Vulkan build for Intel Arc, CUDA build for NVIDIA), and the model `models\Qwen3.8-27B-UD-Q4_K_M.gguf` (16.5 GB, size-verified). It then builds Relay. Re-running is safe; interrupted downloads resume.
   - `setup.cmd -Model 38-27b-q5` uses Q5_K_M (19.8 GB) with 48K context instead of 128K.
   - `setup.cmd -Model all` downloads every model for comparison.
   - `setup.cmd -Backend sycl` uses Intel's SYCL build instead of Vulkan (experimental on Arc).
   - `setup.cmd -Runtime ollama` (or `both`) uses Ollama (`qwen3.8:27b`, Q4_K_M only).
   - `setup.cmd -Toolchains` installs the .NET SDK and CMake; MSVC is checked and reported.
   - `setup.cmd -UpdateLlama` replaces llama.cpp with the newest build (re-run after changing GPU).
4. Double-click `start-relay.cmd`. It starts llama-server in its own window (pinned to the Arc card if several GPUs are present; layers fitted automatically), waits for the model, starts Relay and opens http://127.0.0.1:5000. Options: `-Model 38-27b-q5`, `-Runtime ollama`, `-Ctx 98304`, `-KvInRam`.
5. In Relay Settings choose the local runtime and click Test connection.

## Hardware profile

Arc Pro B60 24 GB + 32 GB RAM: the default Qwen3.8-27B UD-Q4_K_M (15.3 GiB) runs fully in VRAM with a 128K-token context and q8_0 KV cache (about 34-43 KiB per token; only 16 of 64 layers use full attention). Q5_K_M (`38-27b-q5`) gets 48K; other GPUs default to 32K. At 96K+ context the output limit is 32,768 tokens (thinking included), otherwise 16,384. Relay derives its prompt budget from the context: (context - output - 2,048) x 3 characters, two thirds source files and one third prior agent outputs (about 192K and 96K characters at 128K). If the llama-server log shows fewer than all layers offloaded, or prefill and decode slow down together, lower `-Ctx`. `-KvInRam` keeps the weights in VRAM but puts the context cache in RAM (256K default, the model's native maximum): long prompts become much slower, measure first. Never rely on the Windows page file; it is far slower than RAM. All roles share one model and run sequentially (`-np 1`). Thinking mode uses Qwen's recommended sampling (temperature 1.0, top_p 0.95, top_k 20).

Environment: `RELAY_RUNTIME` (`ollama`|`openai`), `OLLAMA_HOST`, `OPENAI_BASE_URL` (default `http://127.0.0.1:8080/v1`), `RELAY_CTX`, `RELAY_MAX_TOKENS`, `RELAY_TIMEOUT_MIN`, `RELAY_THINK` (`0` disables), `RELAY_KEEP_ALIVE`, `RELAY_MODEL` (one model for every role; set by `start-relay`). Existing `data.db` files keep saved agent models; `RELAY_MODEL` overrides them.

## GitHub

1. Create a token: github.com → Settings → Developer settings → Personal access tokens.
   - Fine-grained (recommended): select your repositories; permissions Contents: Read and write, Pull requests: Read and write, Metadata: Read.
   - Classic: the `repo` scope.
2. Relay → Settings → GitHub → paste the token → Connect. It is stored encrypted with Windows DPAPI in `secrets\` (only your Windows account can read it).
3. Projects → Import from GitHub → choose the repository and branch. Relay clones it into `workspace\<owner>\<repo>` and indexes the code (dependencies, build output, binaries and secret-like files are skipped).
4. For each request Relay sends the agents the most relevant files, a repository map, recent commit history and the open pull requests that touch the same files.

Workflows (per project, and a request can override it):
- Pull request (default): changes go to a new branch `<your-login>/<date>-<topic>`; you review the diff, commit, push and open the pull request.
- Direct to branch: "without a PR", "commit directly to main", "без PR", "напрямую в main". Changes are committed to the branch and pushed; if someone pushed meanwhile, Relay rebases. It never force-pushes.

From the chat: "close PR #12", "delete PR #12" (GitHub cannot delete pull requests; Relay closes it and deletes its branch), "reopen PR 12", "squash merge PR #12", "delete branch old-feature", also in Russian. Every action is shown in the plan and runs only after you approve. The default branch is never deleted.

Commits and pull requests are made as you: the git identity on this PC, or your GitHub name with the private `ID+login@users.noreply.github.com` address. Relay adds no marks, signatures or Co-authored-by lines.

Files tab: view, edit, upload (into a target folder) and delete files. Changes tab: diff, commit, push, pull request, discard.

## Web search

Built-in search is the default. Relay installs an isolated Python environment in `tools/search` during setup/update and checks or repairs it at startup. No account, API key, Docker, SearXNG server or URL is required. Initial installation needs an internet connection; if Python is missing, Windows may ask permission to install it. Search installation failure does not stop offline coding and is retried on the next launch.

The one-shot search worker uses the base [DDGS package](https://pypi.org/project/ddgs/) pinned to 9.16.1, with explicitly selected DuckDuckGo, Brave, Bing and Google backends, TLS verification, a 40-second process deadline and a small in-memory result cache. It does not start a listening search server or enable distributed/peer-to-peer features. No search API subscription is required, but upstream engines can block, rate-limit or change their interfaces. Empty results and failures are reported, not replaced with invented findings.

Settings → Web search shows installation status and a test-search field. Optional external SearXNG and Tavily connections remain under Advanced. Older provider settings migrate to built-in (unless search was explicitly Off); saved URLs and keys are retained if you reselect an external provider.

When search is on, the orchestrator can plan up to three research queries (web, official documentation or GitHub code). Queries are shown for approval; findings and URLs then go to the agents. GitHub code search still uses your GitHub connection. Engines receive query text and your connection's IP; visited sites receive page requests. Because the planner has project context, queries can contain confidential project details. Review them before approval. Source files are not intentionally uploaded by this worker, but automatic redaction is not guaranteed. Treat external content as untrusted.

## Pause, save and resume

During planning or an agent response, the send-control area shows a standard two-bar Pause icon alongside Stop. Pause automatically commits the session to `data.db` and to `sessions/session-<run-id>.json` on the SERVER PC running Relay and the model, not the visiting browser. There is no separate Save step. “Pausing” means an in-flight action is still settling; “Paused and saved” means the checkpoint is written and the run has stopped. Then you can close Relay or shut down the PC.

Each session JSON contains the original request, project/source-context snapshot, agent instructions, exact model request bodies (prompts, model and sampling/context settings), saved plan, partial and completed answers, execution position, research context/sources, GitHub action outcomes, progress and event history. It is written using a temporary file, disk flush and rename, with a checksum for corruption detection. Keep it private: it contains project code and prompts. Passwords and GitHub tokens remain in the separate secrets store; model weights and the actual repository files remain in their existing folders.

All sessions are remembered, including stopped, completed and failed sessions. At startup the last selected session is reopened, or the most recently saved session if that browser has no valid selection. Another remote browser can also open any session from Run history: all restoration data lives on the server PC. Reopening does not automatically execute anything. The play icon resumes a paused or stopped session; a discarded/unapproved plan still needs approval. Session files restore missing run records if `data.db` was restored from an older backup; existing records are not overwritten. Completed agents and completed GitHub actions are skipped. Saved model request settings/prompts are reused, with the partial answer supplied to a new model call and instructions to continue. This is text-based continuation, not an exact token/KV-cache checkpoint. An incomplete planning response is rebuilt from the saved request/context and still requires approval. Review resumed output for repetition or inconsistencies.

Streaming text is also checkpointed periodically. After an unexpected process exit, active runs become paused instead of failed; the most recent unsaved fraction of a second can be lost. If a GitHub action was in flight during a crash, Relay blocks automatic replay because its remote outcome is uncertain. Check GitHub before requesting remaining actions. Stop saves the session too; it stays stopped until you explicitly choose Resume.

## Updating the app

### Single launcher and GitHub updates

Relay and llama.cpp/Ollama now run as hidden background processes. The startup console closes automatically after a successful launch; setup/update progress and startup failures remain visible when needed. Click **Status** in the app header to inspect server uptime, activity, server RAM, model connectivity and recent logs. Closing the browser does not stop Relay; running `start-relay.cmd` again opens the existing instance instead of starting a duplicate.

Use **Status → Shut down Relay → Confirm shutdown** on the host PC before applying updates. Shutdown is blocked while a task or API write is active; pause/stop the task and wait for it to save first. Only a model process started and recorded by this installation is stopped. Externally started models are left running. Saved sessions and settings remain untouched.

Diagnostics are written to `logs/relay.stdout.log`, `logs/relay.stderr.log`, `logs/model.stdout.log` and `logs/model.stderr.log` on the server PC. The previous launch's logs are retained with a `.previous` suffix; logs are excluded from GitHub. The status viewer shows a bounded tail and redacts common credential patterns, but logs may still contain sensitive project details. Raw logs and shutdown are local-only; remote signed-in users can view health/status.

The application source is maintained at [VladKlimenko-dev/Relay](https://github.com/VladKlimenko-dev/Relay). Double-click `start-relay.cmd` for the complete flow: check prerequisites, run setup when required, check the repository's `main` branch, rebuild changed application code, then start the model and Relay. Existing valid models are reused; an application update does not replace models, sessions, databases, workspace, credentials or runtime settings.

- `start-relay.cmd -Setup`: explicitly run setup/repair, keeping the configured model/runtime unless you override them.
- `start-relay.cmd -UpdateOnly`: check GitHub and apply an application update without starting Relay.
- `start-relay.cmd -Offline`: skip GitHub and start the installed application; an already completed installation is required.
- Existing launch options such as `-Ctx 65536`, `-KvInRam`, `-Model`, `-Runtime` and `-NoBrowser` remain supported. `-Backend`, `-Toolchains` and `-UpdateLlama` are available for setup/repair.

The public repository needs no GitHub login or API key for updates. Downloads use an exact commit snapshot over HTTPS, with validated archive paths and an application-file allowlist. A local revision marker avoids rebuilding unchanged versions. No `git reset`, `git clean`, database migration or model download is performed by the GitHub updater. Your installed application source files can be replaced by an update, so keep personal application-code modifications in GitHub rather than editing the installation. Imported projects in `workspace` are separate and preserved.

If GitHub is unavailable before any files are changed, an existing working installation can still start. An update that failed after file replacement is flagged as incomplete and blocks startup until repaired. Updates must run with the Relay server stopped; the launcher checks its process marker and local health endpoint. Updater files are application code, so only trusted maintainers should have write access to the repository.

### Applying an update-only ZIP

Stop Relay, extract the new files into the existing Relay folder, and allow replacement of application files. Do not delete the old folder. Run `update-relay.cmd`, then `start-relay.cmd`. The updater rebuilds the app and installs search without downloading models or changing the selected model/runtime.

If moving to a new folder instead, copy these from the old Relay folder: `models`, `tools`, `data.db`, `sessions`, `workspace`, `secrets`, `search-settings.json`, `relay-config.json`, and `.env` if present. Then run `update-relay.cmd`. For a first installation use `setup.cmd`.
Also keep `remote-access.json` and `relay-public.cer` if remote access was configured. The encrypted remote login references the PFX's absolute path; if you move Relay to a different folder, rerun `configure-remote.cmd`.

Preserve any `data.db-wal`, `data.db-shm` or `data.db-journal` files that remain beside the database after stopping Relay; keep them together with `data.db`. The database contains project metadata, agent configuration and history; `sessions` is not a replacement for all database contents. Keep any custom `.pfx` certificate at its configured absolute path, including certificates outside the Relay folder. `secrets` is sensitive and Windows-encrypted credentials are tied to the Windows account, so a different PC/account requires reconnecting credentials. `node_modules` and `dist` are rebuilt by the updater and do not need copying. If `.env` specifies custom data/secrets/workspace locations, preserve those directories too.

## Remote access by IP with an owner login

This is one owner account with full control of this workspace and its connected GitHub account, not a multi-user permissions system. The model still runs on your PC. Keep the PC awake and Relay running.

### Configure in Settings

Open Settings → Remote access on the Windows PC running Relay. The section shows the computer name, local IPv4 addresses and the public IPv4 detected by the Relay backend using [ipify](https://www.ipify.org/). It is the server PC's connection address, not the remote browser's address or a unique PC identifier. Lookup failures are visible; any retained old address is marked last-known, not current. Refresh is rate-limited and a changed public IP is flagged.

Enter the public address, HTTPS port (default 5443), Relay username, password and confirmation, then explicitly confirm enabling owner access and click Save remote access. The password must be 15-256 characters; it is hashed with the existing scrypt flow, never returned by the API. When changing an existing login, enter the current Relay password too. Credential changes are local-only and require the existing authenticated session and CSRF protection when HTTPS is already enabled.

Relay creates a self-signed certificate automatically, saves the login, and displays the HTTPS URL, public certificate download, SHA-256 fingerprint and expiry. Same-address updates reuse the existing certificate unless renewal is selected. Changes apply only after restarting with `start-relay.cmd`; old credentials stay active until that restart. Changing the public IP creates a new certificate that must be trusted again. The existing `configure-remote.cmd` remains available for custom PFX/hostname setup.

No firewall, router or client certificate trust settings are changed automatically. Follow the certificate-trust and network instructions below before connecting from the internet. Public IP lookup is not an inbound-connectivity test and does not establish that the connection supports port forwarding.

### Certificate trust and network setup

1. Stop Relay, replace the application files, and run `setup.cmd` to rebuild the app. Existing model files do not need to be downloaded again.
2. Run `configure-remote.cmd` locally. Enter the public IPv4 address, choose a username, and enter a unique password of at least 15 characters twice. Do not use your GitHub token or GitHub password here.
3. The script creates a self-signed HTTPS certificate and exports the public part as `relay-public.cer`. This certificate is NOT automatically trusted by browsers. Transfer only that public file to your own client devices over a trusted channel, verify the fingerprint, and install it in the appropriate trusted certificate store. On Windows, the Certificate Import Wizard offers Current User → Trusted Root Certification Authorities. Do not click through browser certificate warnings or send credentials until trust and the address match. For unmanaged clients, use a CA-issued certificate instead.
4. Start Relay with `start-relay.cmd`. With the generated certificate, local access is `https://127.0.0.1:5443`; remote access is `https://YOUR_PUBLIC_IP:5443`. Sign in with the Relay username and password.
5. Only after login and certificate trust work locally, add a Windows Firewall inbound TCP rule for port 5443 and forward external TCP 5443 to this PC's LAN IPv4 address, port 5443, in your router. Reserve that LAN address in the router. Prefer a source-IP restriction where practical. The setup script does NOT open firewall ports or change the router.
6. Test from a different internet connection, such as a phone on mobile data. An ISP public IPv4 address is required for this direct-forwarding approach. Behind CGNAT or another upstream NAT you do not control, arrange public IPv4 with the ISP or use a private VPN/tunnel instead; a router rule alone is insufficient.

Never forward ports 5000 (local HTTP), 8080 (llama.cpp) or 11434 (Ollama). Only the HTTPS app port is intended for remote access. Plain HTTP stays bound to loopback and cannot access the application when remote access is enabled. All application APIs require login; only health and login/status endpoints are public.

Passwords are salted/scrypt-hashed. The configuration, certificate passphrase and session signing secret use the same Windows DPAPI store as other local secrets. Sessions use HTTPS-only, HttpOnly, SameSite cookies, a 30-minute sliding lifetime and a 12-hour absolute limit. Login attempts are globally limited to 10 per 15 minutes; a restart clears sessions and the in-memory limit. State-changing API calls require a session CSRF token. Logout invalidates the current session; rerunning configuration and restarting invalidates all sessions. No password-reset endpoint is exposed.

The self-signed certificate expires after 12 months; regenerate and retrust before expiry. If your public IP changes, reconfigure and retrust the new certificate. To use an existing trusted PFX for an IP or hostname, run `configure-remote.cmd -CertificatePfx "C:\path\certificate.pfx"`; it must cover the address you enter. Use that address in the browser (an existing certificate might not cover localhost). Keep the PFX available at the same path and renew it as required.

To turn remote access off, stop Relay, remove `secrets/remote-access.dpapi` and `remote-access.json`, then restart. Close the router/firewall rule as well. Do not expose an older Relay build: it has no login gate.

HTTPS for the entire session and secure session cookies follow the [OWASP session-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). This build is not an independent security audit; Windows certificate setup and your real network must be verified locally before internet exposure.

## Explicit boundaries

- No shell execution, compilation, test execution, training or fine-tuning. File changes happen only in the local clone after you click Apply; nothing reaches GitHub until you commit and push.
- Testing agents draft tests and review code. They must not claim tests passed.
- Source and prior-agent context are limited by the prompt budget above (about 192K and 96K characters at 128K context). Truncation is disclosed in the event log.
- Model calls default to 32,768 context tokens (start-relay sets 128K on a 24 GB Arc), thinking on, up to 16,384 output tokens (thinking included), a 90-minute cancellable timeout, and no cloud fallback.
- Imports allow up to 25 supported text files of 80 KB each. Secret-like filenames are rejected; content is not a substitute for a complete secrets scanner.
- SQLite survives process restarts, not guaranteed redeployment or sandbox expiration. Back up `data.db` when used locally.
- Preview content is stored on the app server. Do not import private source code until comfortable with that environment.
- Evaluation outcomes are user-entered. No Opus model is connected; no benchmark comparison has run.

## Next integration stage

Before claiming autonomous coding or Opus-level performance, add an isolated local worker with per-project filesystem mounts, allowlisted build/test tools, approval gates for writes and shell actions, resource limits, logs, and a verified evaluation harness. Model training is a separate project requiring hardware details and curated training/evaluation data.
