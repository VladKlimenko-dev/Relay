# Relay QA inventory

## Acceptance criteria
- Workspace starts with chat, project context, orchestrator hierarchy and five specialist roles.
- Demo and local model execution are clearly distinguished.
- No model capability or test results are implied without evidence.
- EN/RU requests accepted; all rendering safely uses React text nodes.
- Plan approval, sequential handoffs, cancellation, outputs and export.
- Agents configurable; new runs snapshot settings.
- Projects import supported source files and reject unsupported files.
- History searchable/filterable and opens previous runs.
- Evaluations explicitly manual and initially unbenchmarked.
- Runtime connection failure is clear; no cloud fallback.
- Backend persistence, error states and invalid request validation.

## Functional checks
- Send a task, approve, see steps complete, view/download output and export run.
- Create another task; discard approval; start and stop a third task.
- Submit blank or short input; action disabled.
- Configure a model, disable a specialist, verify plan excludes it; restore.
- Import sample source file; verify project and context count.
- Use each sidebar navigation path, help dialog, project selector and output tabs.
- Search/filter history with matching and missing queries.
- Mark and reset manual evaluation results; download CSV.
- Switch runtime and test unavailable Ollama; live request fails with actionable error; switch back.
- Reload to confirm server-side persistence.
- Local adapter protocol tested against a controlled mock, not claimed as real model quality.

## Visual checks
- Desktop 1440×1000, laptop 1280×800, mobile 375×812, short desktop.
- Each page, project/agent/help/output dialogs, run approval and completed states.
- No horizontal overflow; chat composer visible; workflow nodes readable.
- Keyboard focus and dialog Escape behavior.
- Inspect small/status text contrast and mobile navigation.
- Hosted preview: navigation, demo run, output modal and file export.

## Verified locally
- TypeScript check and production build pass.
- Browser: demo plan, explicit approval, completion, individual output download, help dialog, specialist disable/restore, source-file import, Russian request, discard, active cancellation, history search and status filter, manual evaluation update/reset, CSV download, runtime switching and connection errors.
- Adapter contract fixture: live-mode plan parsing, sequential calls, prior-output handoff, token accounting, redacted private context, invalid input, sensitive filename rejection, concurrency limit, cancellation and terminal-state guards all pass.
- Fixture is a controlled mock Ollama API, not real model inference or a quality benchmark.
- Desktop, laptop and mobile inspected; mobile menu and compact viewport layout corrected. No browser page errors observed.
- Build dependencies updated; production dependency audit reports no known vulnerabilities.
