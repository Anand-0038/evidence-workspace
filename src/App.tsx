import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { compileClaimVerification, compileProposalPreview, confirmClaim, createExportPacket, decideProposal, exampleWorkspace, getReleaseCheck, recordHumanCompilerReview, replaceWorkspace, runExampleAgentReview, toggleEvidenceSharing, type Workspace } from "./domain";
import { registerSiteTools, type SiteToolEvent, type SiteToolRuntime } from "./webmcp";
import { loadWorkspace, parseWorkspaceJson, saveWorkspace } from "./storage";
import {ReviewBuilder,type ReviewBuilderMode} from "./ReviewBuilder";
import {VerificationTrace} from "./VerificationTrace";

const stages=["Draft","Evidence linked","Human reviewed","Export ready"];
const cloneExample=():Workspace=>structuredClone(exampleWorkspace);

export function App(){
  const [browserStorage]=useState<Storage|null>(()=>{try{return window.localStorage}catch{return null}});
  const [initialLoad]=useState(()=>browserStorage?loadWorkspace(browserStorage):{workspace:cloneExample(),warning:"Browser storage is unavailable; changes will remain in memory for this session.",source:"recovered" as const});
  const [workspace,setWorkspace]=useState<Workspace>(initialLoad.workspace);
  const [selectedId,setSelectedId]=useState(initialLoad.workspace.claims[0]?.id??"");
  const [notice,setNotice]=useState<string|null>(initialLoad.warning);
  const [materialLabel,setMaterialLabel]=useState(initialLoad.source==="storage"?"Saved local workspace":"Example workspace");
  const [builderMode,setBuilderMode]=useState<ReviewBuilderMode|null>(null);
  const [toolStatus,setToolStatus]=useState<"unavailable"|"registering"|"registered"|"error">(()=>typeof document.modelContext?.registerTool==="function"?"registering":"unavailable");
  const [toolCount,setToolCount]=useState(0);
  const [lastToolEvent,setLastToolEvent]=useState<SiteToolEvent|null>(null);
  const workspaceRef=useRef(workspace);
  const toolRuntimeRef=useRef<SiteToolRuntime|null>(null);
  const proposalHeadingRef=useRef<HTMLHeadingElement|null>(null);
  workspaceRef.current=workspace;
  const release=useMemo(()=>getReleaseCheck(workspace),[workspace]);
  const claim=workspace.claims.find((item)=>item.id===selectedId)??workspace.claims[0];
  const linked=new Set(claim.linkedEvidenceIds);
  const proposal=workspace.proposals.find((item)=>item.claimId===claim.id&&item.state==="pending");
  const proposalStale=Boolean(proposal&&(proposal.basedOnRevision!==workspace.revision||proposal.claimTextAtCreation!==claim.text));
  const proposalPreview=proposal&&!proposalStale?compileProposalPreview(workspace,proposal.id):null;
  const verification=useMemo(()=>compileClaimVerification(workspace,claim.id),[workspace,claim.id]);
  const guidedStepAvailable=workspace.proposals.every((item)=>item.state!=="pending")&&workspace.claims.some((item)=>item.state==="unreviewed");

  useEffect(()=>{
    let disposed=false;
    if(typeof document.modelContext?.registerTool!=="function"){setToolStatus("unavailable");return}
    setToolStatus("registering");
    void registerSiteTools(()=>workspaceRef.current,(next)=>{workspaceRef.current=next;setWorkspace(next);setNotice("Site tool updated the workspace.")},(event)=>{if(!disposed)setLastToolEvent(event)}).then((runtime)=>{if(disposed){runtime?.abort();return}toolRuntimeRef.current=runtime;setToolCount(runtime?.registeredToolCount()??0);setToolStatus(runtime?"registered":"unavailable")}).catch((error)=>{if(disposed)return;setToolStatus("error");setNotice(error instanceof Error?`Site tool registration failed: ${error.message}`:"Site tool registration failed.")});
    return()=>{disposed=true;toolRuntimeRef.current?.abort();toolRuntimeRef.current=null};
  },[]);

  useEffect(()=>{const runtime=toolRuntimeRef.current;if(!runtime)return;void runtime.reconcileExport().then(()=>setToolCount(runtime.registeredToolCount())).catch((error)=>{setToolStatus("error");setNotice(error instanceof Error?`Export tool reconciliation failed: ${error.message}`:"Export tool reconciliation failed.")})},[workspace.revision]);
  useEffect(()=>{if(!browserStorage)return;const warning=saveWorkspace(browserStorage,workspace);if(warning)setNotice(warning)},[browserStorage,workspace]);
  useEffect(()=>{if(proposal)proposalHeadingRef.current?.focus()},[proposal?.id]);

  const mutate=(operation:(current:Workspace)=>Workspace,message?:string)=>{
    try{setLastToolEvent(null);setWorkspace((current)=>operation(current));setNotice(message??null)}catch(error){setNotice(error instanceof Error?error.message:"The operation failed.")}
  };
  const exportPacket=()=>{
    try{
      const blob=new Blob([createExportPacket(workspace)],{type:"text/markdown;charset=utf-8"});
      const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=`reviewed-report-r${workspace.revision}.md`;anchor.click();URL.revokeObjectURL(url);setNotice("Reviewed packet exported from the current revision.");
    }catch(error){setNotice(error instanceof Error?error.message:"Export failed.")}
  };
  const exportWorkspaceJson=()=>{
    const blob=new Blob([JSON.stringify(workspace,null,2)],{type:"application/json;charset=utf-8"});
    const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=`evidence-workspace-r${workspace.revision}.json`;anchor.click();URL.revokeObjectURL(url);setNotice("Workspace JSON exported locally. No report was published.");
  };
  const importWorkspaceJson=async(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.currentTarget.files?.[0];event.currentTarget.value="";
    if(!file)return;
    if(file.size>1_000_000){setNotice("Import rejected: workspace JSON must be 1 MB or smaller.");return}
    try{const parsed=parseWorkspaceJson(await file.text());if(!parsed.ok){setNotice(`Import rejected: ${parsed.error}`);return}const next=replaceWorkspace(workspaceRef.current,parsed.workspace,"Imported workspace; prior decisions require confirmation in this session.");setLastToolEvent(null);setWorkspace(next);setSelectedId(next.claims[0].id);setMaterialLabel("Imported local workspace");setNotice(`Imported ${next.claims.length} claims and ${next.evidence.length} evidence items. Prior approvals were cleared; review sharing permissions before using site tools.`)}catch(error){setNotice(error instanceof Error?`Import failed: ${error.message}`:"Import failed.")}
  };
  const applyBuiltWorkspace=(next:Workspace,message:string,nextSelectedId:string)=>{const replacement=builderMode==="new"?replaceWorkspace(workspaceRef.current,next,"Created a new review; the previous workspace revision was retired."):next;setLastToolEvent(null);setWorkspace(replacement);setSelectedId(nextSelectedId);setMaterialLabel(replacement.title?"User-created local review":"Edited local workspace");setNotice(message);setBuilderMode(null)};

  return <><a className="skip-link" href="#main-content">Skip to review workspace</a><main id="main-content" className={`app-shell ${proposal?"has-proposal":""}`}>
    <header className="masthead">
      <div>
        <p className="kicker">Release desk / revision {workspace.revision}</p>
        <h1>Catch the claim that should not ship.</h1>
        <p className="subhead">Compare each report claim with its exact evidence. A browser agent can do the tedious checks; a human still owns the decision to release.</p>
      </div>
      <div className="header-actions">
        <span className="capability-wrap"><span className={`capability ${toolStatus==="registered"?"available":"unavailable"}`}>{toolStatus==="registered"?"Browser agent connected":toolStatus==="registering"?"Connecting browser agent":toolStatus==="error"?"Browser agent setup error":"Browser agent not connected"}</span>{toolStatus==="unavailable"&&<small>This browser does not expose WebMCP.</small>}</span>
        <button className="text-button primary-text-button" onClick={()=>setBuilderMode("new")}>New review</button>
        <button className="text-button" disabled={Boolean(proposal)} onClick={()=>setBuilderMode("claim")}>Add claim</button>
        <button className="text-button" disabled={Boolean(proposal)} onClick={()=>setBuilderMode("evidence")}>Add evidence</button>
        <label className="text-button file-button">Import workspace JSON<input className="visually-hidden" type="file" accept="application/json,.json" onChange={importWorkspaceJson}/></label>
        <button className="text-button" onClick={exportWorkspaceJson}>Export workspace JSON</button>
        <button className="text-button" onClick={()=>{if(!window.confirm("Replace the current browser-local workspace with the authored example? Export JSON first if you need a backup."))return;setLastToolEvent(null);setWorkspace(replaceWorkspace(workspaceRef.current,cloneExample(),"Reset to the authored example; the previous workspace revision was retired."));setSelectedId("claim-growth");setMaterialLabel("Example workspace");setNotice("Example workspace reset; prior revision tokens are stale.")}}>Reset example</button>
      </div>
    </header>

    <aside className="fixture-note"><strong>{materialLabel}{workspace.title?` / ${workspace.title}`:""}</strong> — browser-local material. Imported facts must remain bound to exact excerpts; review sharing permissions before agent use.</aside>

    <section className="review-launch" aria-labelledby="start-title">
      <div>
        <p className="kicker">Start here</p>
        <h2 id="start-title">One job: stop unsupported claims before they leave the desk.</h2>
        <p>Read the selected claim, inspect the check path, and record the compiler result. If a browser agent is connected, it can link shared evidence and stage a correction—but it never approves or publishes.</p>
        <div className="launch-actions">
          <button className="agent-button" onClick={()=>mutate(runExampleAgentReview,"Guided sample advanced one authored-example step. This illustrates the same domain logic, not a WebMCP call.")} disabled={!guidedStepAvailable}>Run guided sample step</button>
          <button className="secondary-action" onClick={()=>mutate((current)=>recordHumanCompilerReview(current,claim.id),"Recorded the current compiler result. A human decision is still required before release.")}>Record current compiler result</button>
        </div>
        <p className="launch-disclosure">The guided sample is available without WebMCP so the product remains understandable in any browser. It never claims an agent ran.</p>
      </div>
      <ol className="review-steps">
        <li><span>1</span><strong>Inspect</strong><small>Choose a claim and read its exact source.</small></li>
        <li><span>2</span><strong>Verify</strong><small>Use the visible compiler checks to find gaps or conflicts.</small></li>
        <li><span>3</span><strong>Decide</strong><small>Approve a correction or confirm a supported finding.</small></li>
      </ol>
    </section>

    <section className={`release-rail stage-${release.stage}`} aria-labelledby="release-title">
      <div className="release-copy"><p id="release-title" className="kicker">Release invariant</p><strong>{release.ready?"Packet unlocked":"Export locked"}</strong><span>{release.ready?"Every claim is compiled and resolved.":`${release.blockers[0]}${release.blockers.length>1?` · +${release.blockers.length-1} more`:""}`}</span></div>
      <ol>{stages.map((stage,index)=><li key={stage} className={index<=release.stage?"reached":""} aria-current={index===release.stage?"step":undefined}><span>{index<release.stage?"✓":index+1}</span>{stage}</li>)}</ol>
      <button className="export-button" disabled={!release.ready} onClick={exportPacket}>Export reviewed packet</button>
    </section>

    <section className={`agent-handoff ${lastToolEvent&&!lastToolEvent.ok?"handoff-denied":""}`} aria-labelledby="handoff-title">
      <div><p id="handoff-title" className="kicker">{lastToolEvent?"Last browser-agent action":"Browser agent connection"}</p><strong>{toolStatus==="registered"?(lastToolEvent?`${lastToolEvent.tool} · r${lastToolEvent.workspaceRevision} · ${lastToolEvent.outcome}`:"Browser agent ready to inspect shared evidence and stage work."):toolStatus==="registering"?"Connecting browser agent…":"No browser agent in this session—manual review is still available."}</strong></div>
      <div>{lastToolEvent?<p>{lastToolEvent.message}</p>:toolStatus==="registered"?<p>Try: “Check this report, stage the smallest correction if needed, and stop before approval or export.”</p>:<details className="webmcp-help"><summary>How to connect a WebMCP browser agent</summary><ol><li>Open this same URL in Chrome 149 or newer.</li><li>Open <code>chrome://flags/#enable-webmcp-testing</code>.</li><li>Enable the flag and fully relaunch Chrome.</li><li>Reload this page. The status changes to “Browser agent connected” when the browser exposes the API.</li></ol><p>This in-app browser does not provide that API to the page, so this is a browser capability boundary—not an app error.</p></details>}</div>
      <div className="handoff-next"><span>{toolStatus==="registered"?`${toolCount} SITE TOOL${toolCount===1?"":"S"} REGISTERED`:"MANUAL REVIEW MODE"}</span><strong>{lastToolEvent?.tool==="review_propose_revision"?"Next: review the compiler preview":lastToolEvent&&!lastToolEvent.ok?"Next: follow the recovery instruction":lastToolEvent?"Next: inspect the visible workspace":toolStatus==="registered"?"Next: ask the agent to inspect shared evidence":"Next: inspect the compiler result or run the guided sample"}</strong></div>
    </section>

    {notice&&<div className="notice" role="status" aria-live="polite">{notice}<button aria-label="Dismiss message" onClick={()=>setNotice(null)}>×</button></div>}

    <section className="proof-table" aria-label="Claim and evidence review">
      <div className="claims-column">
        <div className="section-heading"><div><p className="kicker">Claim folio</p><h2>What the draft says</h2></div></div>
        <ol className="claim-list">{workspace.claims.map((item,index)=><li key={item.id}><button className={item.id===claim.id?"selected":""} onClick={()=>setSelectedId(item.id)} aria-pressed={item.id===claim.id}><span className="claim-number">0{index+1}</span><span className="claim-text">{item.text}</span><span className={`state state-${item.state}`}>{item.state}</span></button></li>)}</ol>
        <article className={`claim-detail ${claim.state==="contradicted"?"is-contradicted":""}`}>
          <p className="kicker">Selected wording</p><blockquote>{claim.text}</blockquote>
          {claim.rationale&&<p className="rationale"><strong>Review note:</strong> {claim.rationale}</p>}
          <dl><div><dt>Agent review</dt><dd>{claim.state}</dd></div><div><dt>Human decision</dt><dd>{claim.humanDecision}</dd></div></dl>
          {claim.humanDecision!=="approved"&&<button className="record-result" onClick={()=>mutate((current)=>recordHumanCompilerReview(current,claim.id),"Recorded the current compiler result. A human decision is still required before release.")}>{verification.status==="pass"?"Record compiler pass":"Record compiler finding"}</button>}
          {claim.state==="supported"&&claim.humanDecision!=="approved"&&<button className="confirm-finding" onClick={()=>mutate((current)=>confirmClaim(current,claim.id),"Compiled finding confirmed by human.")}>Confirm compiled finding</button>}
        </article>
        <VerificationTrace manifest={verification} humanDecision={claim.humanDecision}/>
      </div>

      <div className="evidence-column">
        <div className="section-heading"><div><p className="kicker">Evidence sheets</p><h2>What the source says</h2></div><span className="share-count">{workspace.evidence.filter((item)=>item.sharedWithAgent).length}/{workspace.evidence.length} shared</span></div>
        <div className="evidence-stack">{workspace.evidence.map((item)=><article key={item.id} className={`evidence-sheet ${linked.has(item.id)?"linked":""}`}>
          <header><div><p className="source-label">{item.sourceLabel}</p><h3>{item.title}</h3></div><label className="share-control"><input type="checkbox" checked={item.sharedWithAgent} onChange={()=>mutate((current)=>toggleEvidenceSharing(current,item.id))}/><span>{item.sharedWithAgent?"Shared with site tools":"Not shared with site tools"}</span></label></header>
          <blockquote>{item.passage}</blockquote>
          {linked.has(item.id)&&<p className="evidence-link"><span>↳</span> Linked to selected claim</p>}
        </article>)}</div>
      </div>
    </section>

    {proposal&&<section className="proposal-tray" aria-labelledby="proposal-title" aria-live="polite">
      <div><p className="kicker">Human checkpoint / proposal {proposal.id}</p><h2 id="proposal-title" ref={proposalHeadingRef} tabIndex={-1}>{proposalStale?"Proposal is stale":"Revision staged, not applied"}</h2><p>{proposalStale?"The workspace changed after this proposal was staged. Dismiss it and ask the agent to stage a new revision.":proposal.reason}</p></div>
      <div className="proposal-copy"><blockquote>{proposal.proposedText}</blockquote>{proposalPreview&&<div className={`proposal-preview preview-${proposalPreview.status}`}><strong>Compiler preview: {proposalPreview.status.toUpperCase()}</strong><span>{proposalPreview.checks.filter((item)=>item.status==="fail").length?`${proposalPreview.checks.filter((item)=>item.status==="fail").length} deterministic check${proposalPreview.checks.filter((item)=>item.status==="fail").length===1?"":"s"} would fail.`:"All deterministic checks would pass. Human approval is still required."}</span></div>}</div>
      <div className="proposal-actions"><button className="reject" onClick={()=>mutate((current)=>decideProposal(current,proposal.id,"rejected"),proposalStale?"Stale proposal dismissed by human.":"Revision rejected by human.")}>{proposalStale?"Dismiss stale proposal":"Reject revision"}</button><button className="approve" disabled={proposalStale} onClick={()=>mutate((current)=>decideProposal(current,proposal.id,"accepted"),"Revision approved by human.")}>Approve revision</button></div>
    </section>}

    <section className="activity-ledger"><div><p className="kicker">Activity ledger</p><h2>Accountable changes</h2><p className="ledger-count">All {workspace.activity.length} recorded events</p></div><ol>{[...workspace.activity].reverse().map((item)=><li key={item.id}><span className={`actor actor-${item.actor}`}>{item.actor}</span><span>{item.message}</span><code>r{item.revision}</code></li>)}</ol></section>
  </main>{builderMode&&<ReviewBuilder mode={builderMode} workspace={workspace} selectedClaimId={claim.id} onClose={()=>setBuilderMode(null)} onApply={applyBuiltWorkspace}/>}</>;
}
