# Evidence Workspace

Status: active local prototype. It is not deployed or submitted. Native tool discovery is verified locally in Chrome 150 with WebMCP testing enabled; a real tool execution in a supported interactive client has not yet been captured.

AI-assisted reports often reach an editor with confident numbers and weak release evidence. Evidence Workspace turns that last review into a visible, fail-closed workflow: a browser agent can inspect evidence the editor shared, run deterministic checks, and stage corrected wording, but every claim still needs a human confirmation before export.

The included walkthrough starts with a report claiming 40% growth. The linked source says weekly reviews rose from 50 to 60, so the compiler derives 20%, blocks release, and shows the failed arithmetic beside the wording. The agent stages a correction; the editor approves it. A second supported claim remains blocked until its private source is shared and the compiled finding is confirmed.

All bundled report material is authored fixture data and is labeled in the interface. The compiler checks internal consistency between typed assertions, exact source excerpts, units, scope, and arithmetic. It does not determine objective truth.

## Architecture

```mermaid
flowchart LR
    H["Editor in the visible page"] --> D["Revisioned workspace"]
    A["Browser agent"] --> W["Imperative WebMCP tools"]
    W --> D
    D --> C["Deterministic compiler"]
    C --> M["Verification manifest"]
    M --> G{"All checks and human confirmations pass?"}
    G -- No --> B["Export stays locked"]
    G -- Yes --> E["Verified Markdown packet"]
    H -->|"share evidence, approve revisions, confirm findings"| G
```

The React interface and WebMCP handlers call the same domain functions. Agent writes require the current workspace revision. Private evidence is denied, canceled calls do not commit, stale proposals cannot be approved, missing or conflicting sources fail closed, and the export tool is registered only while the release invariant passes. Valid workspaces persist in browser local storage; malformed stored data is quarantined and replaced with the labeled safe example.

## Site tools

- `review_get_summary`: compact release state without source passages
- `review_list_claims`: current wording and review states
- `review_get_claim_context`: one claim and only its linked, human-shared evidence
- `review_run_checks`: read-only deterministic compiler output
- `review_link_evidence`: revision-guarded evidence link
- `review_flag_claim`: records a review state; `supported` is rejected unless checks pass
- `review_propose_revision`: stages wording and an optional typed assertion for human review
- `review_get_release_check`: exact blockers and next human action
- `review_export_packet`: dynamically available only after every release invariant passes

No WebMCP tool can approve a proposal, confirm a finding, download a file, publish a report, or change evidence-sharing permissions.

## Run locally

Requirements: Node.js 20+ and Corepack.

```bash
corepack pnpm install
corepack pnpm dev
```

Open the printed local URL. The “Run next fixture agent step” control drives the same domain path for local walkthroughs, but it is explicitly not proof of a real WebMCP client call.

## Verify

```bash
corepack pnpm check
```

The command runs TypeScript checks, Vitest contracts, and a production build. Current automated coverage includes compiler arithmetic, exact-excerpt binding, missing and conflicting sources, private evidence, human confirmation, stale proposals, canceled tool calls, dynamic export registration, cleanup, and the release invariant.

Local headless-Chrome checks also cover the contradiction-to-approval flow and 320px horizontal overflow. A separate Chrome 150 probe verifies native registration and discovery of the eight locked-state tools. These checks do not prove an interactive tool invocation. A supported ChatGPT or headed Chrome write, public deployment, public repository, demo video, and Devpost submission remain separate external gates.

## Current boundary

- Local fixture and automated checks: verified
- Human browser flow in headless Chrome: verified locally
- Chrome 150 WebMCP registration and discovery on the local origin: verified locally
- Chrome or ChatGPT WebMCP tool execution: unverified
- Validated browser-local persistence: verified locally
- User-supplied report ingestion: not implemented
- Deployment, public repository, video, and submission: not completed

## License

[MIT](./LICENSE)
