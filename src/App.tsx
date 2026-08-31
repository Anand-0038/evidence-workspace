import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { compileClaimVerification, compileProposalPreview, confirmClaim, createExportPacket, decideProposal, exampleWorkspace, getReleaseCheck, recordHumanCompilerReview, replaceWorkspace, toggleEvidenceSharing, type HumanDecision, type SourceFact, type VerificationManifest, type Workspace } from "./domain";
import { registerSiteTools, type SiteToolEvent, type SiteToolRuntime } from "./webmcp";
import { loadWorkspace, parseWorkspaceJson, saveWorkspace } from "./storage";
import {ReviewBuilder,type ReviewBuilderMode} from "./ReviewBuilder";
import {VerificationTrace} from "./VerificationTrace";

const stages=["Draft","All evidence linked","All checks complete","Export ready"];
const cloneExample=():Workspace=>structuredClone(exampleWorkspace);
const claimStateLabel={unreviewed:"Needs review",supported:"Checks pass",contradicted:"Conflict found",unsupported:"Insufficient evidence"} as const;
const decisionLabel={pending:"Awaiting confirmation",approved:"Confirmed",rejected:"Not confirmed"} as const;
const highlightBoundValues=(excerpt:string,fact:SourceFact)=>{const values=fact.kind==="range"?[fact.baseline,fact.observed]:[fact.value];return excerpt.split(/(-?\d[\d,]*(?:\.\d+)?)/g).map((part,index)=>{const parsed=Number(part.replaceAll(",",""));return part&&Number.isFinite(parsed)&&values.some((value)=>Math.abs(value-parsed)<=0.01)?<mark key={index}>{part}</mark>:part})};
type ToolStatus="unavailable"|"registering"|"registered"|"error";
export const isWebMcpReady=(status:ToolStatus,count:number)=>status==="registered"&&count>0;
export const formatSourceValue=(fact:SourceFact|undefined)=>fact?.kind==="range"?`${fact.baseline} → ${fact.observed}`:fact?.kind==="scalar"?String(fact.value):"—";
export const getReleaseSnapshotMessage=(verification:VerificationManifest,hasBoundSource:boolean,humanDecision:HumanDecision)=>{
  const valueCheck=verification.checks.find((item)=>item.id==="value-check");
  if(!hasBoundSource||valueCheck?.status==="blocked")return "Source unavailable — comparison cannot run. Release stays locked.";
  if(valueCheck?.status==="fail")return "These values do not agree. Release stays locked.";
  if(verification.status!=="pass")return `${verification.checks.find((item)=>item.status!=="pass")?.detail??"A deterministic check needs attention."} Release stays locked.`;
  if(humanDecision!=="approved")return "The values agree. Your confirmation is still required.";
  return "The bound source and claim agree.";
};

export function App(){
  const [browserStorage]=useState<Storage|null>(()=>{try{return window.localStorage}catch{return null}});
  const [initialLoad]=useState(()=>browserStorage?loadWorkspace(browserStorage):{workspace:cloneExample(),warning:"Browser storage is unavailable; changes will remain in memory for this session.",source:"recovered" as const});
  const [workspace,setWorkspace]=useState<Workspace>(initialLoad.workspace);
  const [selectedId,setSelectedId]=useState(initialLoad.workspace.claims[0]?.id??"");
  const [notice,setNotice]=useState<string|null>(initialLoad.warning);
  const [materialLabel,setMaterialLabel]=useState(initialLoad.source==="storage"?"Saved local workspace":"Example workspace");
  const [builderMode,setBuilderMode]=useState<ReviewBuilderMode|null>(null);
  const [toolStatus,setToolStatus]=useState<ToolStatus>(()=>typeof document.modelContext?.registerTool==="function"?"registering":"unavailable");
  const [toolCount,setToolCount]=useState(0);
  const [capabilityIssue,setCapabilityIssue]=useState<string|null>(null);
  const [lastToolEvent,setLastToolEvent]=useState<SiteToolEvent|null>(null);
  const workspaceRef=useRef(workspace);
  const toolRuntimeRef=useRef<SiteToolRuntime|null>(null);
  const proposalHeadingRef=useRef<HTMLHeadingElement|null>(null);
  const claimDetailRef=useRef<HTMLElement|null>(null);
  workspaceRef.current=workspace;
  const webMcpReady=isWebMcpReady(toolStatus,toolCount);
  const release=useMemo(()=>getReleaseCheck(workspace),[workspace]);
  const claim=workspace.claims.find((item)=>item.id===selectedId)??workspace.claims[0];
  const linked=new Set(claim.linkedEvidenceIds);
  const proposal=workspace.proposals.find((item)=>item.claimId===claim.id&&item.state==="pending");
  const proposalStale=Boolean(proposal&&(proposal.basedOnRevision!==workspace.revision||proposal.claimTextAtCreation!==claim.text));
  const proposalPreview=proposal&&!proposalStale?compileProposalPreview(workspace,proposal.id):null;
  const verification=useMemo(()=>compileClaimVerification(workspace,claim.id),[workspace,claim.id]);
  const readableBlockers=workspace.claims.flatMap((item)=>{
    const manifest=compileClaimVerification(workspace,item.id);
    const subject=`“${item.text}”`;
    const blockers:string[]=[];
    if(item.linkedEvidenceIds.length===0) blockers.push(`${subject} still needs linked evidence`);
    else if(manifest.status!=="pass") blockers.push(`${subject} has a ${manifest.status==="fail"?"conflict":"missing check"}`);
    if(item.state==="unreviewed") blockers.push(`${subject} needs review`);
    else if(item.state==="contradicted") blockers.push(`${subject} has an unresolved conflict`);
    else if(item.state==="unsupported") blockers.push(`${subject} has insufficient evidence`);
    else if(item.humanDecision!=="approved") blockers.push(`${subject} awaits confirmation`);
    return blockers;
  });
  if(workspace.proposals.some((item)=>item.state==="pending")) readableBlockers.push("A staged correction awaits your decision");
  const uniqueBlockers=[...new Set(readableBlockers)];
  const attentionClaimCount=workspace.claims.filter((item)=>item.state!=="supported"||item.humanDecision!=="approved"||compileClaimVerification(workspace,item.id).status!=="pass").length;
  const boundEvidence=workspace.evidence.find((item)=>linked.has(item.id)&&item.sharedWithAgent&&item.facts.some((fact)=>fact.metric.trim().toLowerCase()===claim.assertion.metric.trim().toLowerCase()));
  const boundFact=boundEvidence?.facts.find((fact)=>fact.metric.trim().toLowerCase()===claim.assertion.metric.trim().toLowerCase());
  const sourceValue=formatSourceValue(boundFact);
  const snapshotMessage=getReleaseSnapshotMessage(verification,Boolean(boundFact),claim.humanDecision);
  const materialBoundary=materialLabel==="Example workspace"?"Browser-local authored sample":"Browser-local material";
  const copyAgentPrompt=async()=>{const prompt=`Review the selected claim against only the evidence shared with site tools. Run the checks, stage the smallest correction if needed, and stop before approval or export.`;try{await navigator.clipboard.writeText(prompt);setNotice("Agent review prompt copied. Paste it into your browser agent.")}catch{setNotice(`Copy this prompt into your browser agent: ${prompt}`)}};
  const inspectSelectedClaim=()=>{const target=claimDetailRef.current;if(!target)return;target.focus({preventScroll:true});target.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"})};

  useEffect(()=>{
    let disposed=false;
    if(typeof document.modelContext?.registerTool!=="function"){setToolStatus("unavailable");return}
    setToolStatus("registering");
    void registerSiteTools(()=>workspaceRef.current,(next)=>{workspaceRef.current=next;setWorkspace(next);setNotice("Site tool updated the workspace.")},(event)=>{if(!disposed)setLastToolEvent(event)}).then((runtime)=>{if(disposed){runtime?.abort();return}toolRuntimeRef.current=runtime;setToolCount(runtime?.registeredToolCount()??0);setToolStatus(runtime?"registered":"unavailable")}).catch((error)=>{if(disposed)return;setToolStatus("error");setNotice(error instanceof Error?`Site tool registration failed: ${error.message}`:"Site tool registration failed.")});
    return()=>{disposed=true;toolRuntimeRef.current?.abort();toolRuntimeRef.current=null};
  },[]);

  useEffect(()=>{const context=document.modelContext;if(!context?.getTools)return;let disposed=false;const syncNativeTools=()=>{void context.getTools().then((tools)=>{if(!disposed)setToolCount(tools.length)}).catch(()=>{/* Registration reconciliation reports actionable errors separately. */})};context.addEventListener("toolchange",syncNativeTools);syncNativeTools();return()=>{disposed=true;context.removeEventListener("toolchange",syncNativeTools)}},[]);

  useEffect(()=>{const runtime=toolRuntimeRef.current;if(!runtime)return;void runtime.reconcileExport().then(()=>{setToolCount(runtime.registeredToolCount());setCapabilityIssue(null)}).catch((error)=>{const message=error instanceof Error?error.message:"Unknown reconciliation error.";setCapabilityIssue("Verified export could not be synchronized. Core review tools remain available.");setNotice(`Verified export synchronization failed: ${message}`)})},[workspace.revision]);
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
    try{const parsed=parseWorkspaceJson(await file.text());if(!parsed.ok){setNotice(`Import rejected: ${parsed.error}`);return}const next=replaceWorkspace(workspaceRef.current,parsed.workspace,"Imported workspace; prior decisions require confirmation in this session.",{trustIncomingHistory:false});setLastToolEvent(null);setWorkspace(next);setSelectedId(next.claims[0].id);setMaterialLabel("Imported local workspace");setNotice(`Imported ${next.claims.length} claims and ${next.evidence.length} evidence items. Prior approvals were cleared; imported history is not treated as current-session provenance.`)}catch(error){setNotice(error instanceof Error?`Import failed: ${error.message}`:"Import failed.")}
  };
  const applyBuiltWorkspace=(next:Workspace,message:string,nextSelectedId:string)=>{const replacement=builderMode==="new"?replaceWorkspace(workspaceRef.current,next,"Created a new review; the previous workspace revision was retired."):next;setLastToolEvent(null);setWorkspace(replacement);setSelectedId(nextSelectedId);setMaterialLabel(replacement.title?"User-created local review":"Edited local workspace");setNotice(message);setBuilderMode(null)};

  return <><a className="skip-link" href="#main-content">Skip to review workspace</a><main id="main-content" className={`app-shell ${proposal?"has-proposal":""}`}>
    <header className="masthead">
      <div className="masthead-row">
        <div className="product-mark"><strong>Evidence Workspace</strong><span>Workspace r{workspace.revision}</span></div>
      <nav className="header-actions" aria-label="Workspace actions">
        <button className="text-button primary-text-button" onClick={()=>setBuilderMode("new")}>New review</button>
        <button className="text-button" disabled={Boolean(proposal)} onClick={()=>setBuilderMode("claim")}>Add claim</button>
        <button className="text-button" disabled={Boolean(proposal)} onClick={()=>setBuilderMode("evidence")}>Add evidence</button>
        <details className="workspace-menu"><summary>Workspace</summary><div><label className="text-button file-button">Import workspace JSON<input className="visually-hidden" type="file" accept="application/json,.json" onChange={importWorkspaceJson}/></label><button className="text-button" onClick={exportWorkspaceJson}>Export workspace JSON</button><button className="text-button" onClick={()=>{if(!window.confirm("Replace the current browser-local workspace with the authored example? Export JSON first if you need a backup."))return;setLastToolEvent(null);setWorkspace(replaceWorkspace(workspaceRef.current,cloneExample(),"Reset to the authored example; the previous workspace revision was retired."));setSelectedId("claim-growth");setMaterialLabel("Example workspace");setNotice("Example workspace reset; prior revision tokens are stale.")}}>Reset example</button></div></details>
      </nav>
        <span className="capability-wrap"><span className={`capability ${webMcpReady?"available":"unavailable"}`}>{toolStatus==="error"?"WebMCP setup error":lastToolEvent?`Agent active · ${lastToolEvent.tool}`:webMcpReady?`WebMCP ready · ${toolCount} tools available`:toolStatus==="registering"?"Preparing WebMCP tools":"Manual review mode"}</span>{capabilityIssue?<small>{capabilityIssue}</small>:!webMcpReady&&toolStatus==="unavailable"?<small>Connect WebMCP when you want agent assistance.</small>:null}</span>
      </div>
    </header>

    <section className="review-launch" aria-labelledby="start-title">
      <div>
        <p className="kicker">Claim review, with accountable boundaries</p>
        <h1 id="start-title">Stop unsupported claims before they leave your team.</h1>
        <p>Compare each claim with the exact evidence supplied for it. The compiler checks consistency; a browser agent can inspect only what you share and stage a correction. You decide what changes and what leaves.</p>
        <p className="workspace-context"><span className="material-kicker">{materialBoundary}</span><strong>{materialLabel}{workspace.title?` · ${workspace.title}`:""}</strong></p>
        <div className="launch-actions">
          {webMcpReady?<button className="agent-button" onClick={copyAgentPrompt}>Copy agent review prompt</button>:<button className="agent-button" onClick={inspectSelectedClaim}>Inspect this mismatch</button>}
        </div>
        {!webMcpReady&&<p className="launch-disclosure">Manual review remains fully usable. WebMCP adds agent discovery and bounded collaboration when the browser exposes it.</p>}
      </div>
      <div className="review-path">
        <p className="kicker">Release snapshot</p>
        <div className={`conflict-snapshot snapshot-${verification.status}`}><div><span>Claim</span><strong>{claim.assertion.kind==="percentage_change"?`${claim.assertion.claimedPercent}%`:claim.text}</strong></div><div><span>Bound source</span><strong>{sourceValue}{boundFact?.kind==="range"&&claim.assertion.kind==="percentage_change"?Math.abs(boundFact.baseline)<=0.01?" = undefined change":` = ${Math.round(((boundFact.observed-boundFact.baseline)/boundFact.baseline)*10000)/100}%`:""}</strong></div><p>{snapshotMessage}</p></div>
        <div className="release-key" aria-label="Permission boundary: the agent can check and stage; the reviewer can approve and export">
          <p className="kicker">The release key stays with you</p>
          <div className="permission-row agent-permission"><span aria-hidden="true">↗</span><div><strong>Agent</strong><small>Check evidence · stage a correction</small></div></div>
          <div className="permission-row human-permission"><span aria-hidden="true">✓</span><div><strong>You</strong><small>Approve a change · unlock export</small></div></div>
        </div>
      </div>
    </section>

    <section className={`release-rail stage-${release.stage}`} aria-labelledby="release-title">
      <div className="release-copy"><p id="release-title" className="kicker">Overall report readiness</p><strong>{release.ready?"Packet unlocked":"Export locked"}</strong><span>{release.ready?"Every claim is compiled and resolved.":`${attentionClaimCount} claim${attentionClaimCount===1?"":"s"} need attention · ${uniqueBlockers[0]??"Review the workspace"}`}</span>{!release.ready&&<details className="release-blockers"><summary>What needs attention</summary><ul>{uniqueBlockers.map((blocker,index)=><li key={`${blocker}-${index}`}>{blocker}</li>)}</ul></details>}</div>
      <ol>{stages.map((stage,index)=><li key={stage} className={index<=release.stage?"reached":""} aria-current={index===release.stage?"step":undefined}><span>{index<release.stage?"✓":index+1}</span>{stage}</li>)}</ol>
      <button className="export-button" disabled={!release.ready} onClick={exportPacket}>Export reviewed packet</button>
    </section>

    {notice&&<div className="notice" role="status" aria-live="polite">{notice}<button aria-label="Dismiss message" onClick={()=>setNotice(null)}>×</button></div>}

    <section className="proof-table" aria-label="Claim and evidence review">
      <div className="claims-column">
        <div className="section-heading"><div><p className="kicker">Claims</p><h2>What this report says</h2></div></div>
        <ol className="claim-list">{workspace.claims.map((item,index)=><li key={item.id}><button className={item.id===claim.id?"selected":""} onClick={()=>setSelectedId(item.id)} aria-pressed={item.id===claim.id}><span className="claim-number">0{index+1}</span><span className="claim-text">{item.text}</span><span className={`state state-${item.state}`}>{claimStateLabel[item.state]}</span></button></li>)}</ol>
        <article ref={claimDetailRef} tabIndex={-1} className={`claim-detail ${claim.state==="contradicted"?"is-contradicted":""}`}>
          <p className="kicker">Selected claim</p><blockquote>{claim.text}</blockquote>
          {claim.rationale&&<p className="rationale"><strong>Review note:</strong> {claim.rationale}</p>}
          <dl><div><dt>Review status</dt><dd>{claimStateLabel[claim.state]}</dd></div><div><dt>Human decision</dt><dd>{decisionLabel[claim.humanDecision]}</dd></div></dl>
          <button className="record-result" disabled={Boolean(proposal)} onClick={()=>setBuilderMode("edit-claim")}>Edit claim</button>
          {claim.state==="unreviewed"&&<><button className="record-result" onClick={()=>mutate((current)=>recordHumanCompilerReview(current,claim.id),"Saved the current compiler result. A separate human confirmation is required for a passing claim.")}>Save compiler result</button><p className="record-help">Saves the deterministic outcome to this claim. If every check passes, you confirm release eligibility separately.</p></>}
          {claim.state==="supported"&&claim.humanDecision!=="approved"&&<button className="confirm-finding" onClick={()=>mutate((current)=>confirmClaim(current,claim.id),"Claim confirmed by a human for release.")}>Confirm claim for release</button>}
        </article>
        <VerificationTrace manifest={verification} humanDecision={claim.humanDecision}/>
      </div>

      <div className="evidence-column">
        <div className="section-heading"><div><p className="kicker">Evidence</p><h2>What the sources say</h2></div><span className="share-count">{workspace.evidence.filter((item)=>item.sharedWithAgent).length}/{workspace.evidence.length} shared</span></div>
        <div className="evidence-stack">{workspace.evidence.map((item)=><article key={item.id} className={`evidence-sheet ${linked.has(item.id)?"linked":""}`}>
          <header><div><p className="source-label">{item.sourceLabel}</p><h3>{item.title}</h3></div><label className="share-control"><input type="checkbox" checked={item.sharedWithAgent} onChange={()=>mutate((current)=>toggleEvidenceSharing(current,item.id))}/><span>{item.sharedWithAgent?"Shared with browser agent":"Private from browser agent"}</span></label></header>
          <blockquote>{item.passage}</blockquote>
          {linked.has(item.id)&&boundEvidence?.id===item.id&&boundFact&&<p className="bound-excerpt"><span className="bound-label">Exact excerpt used for this claim</span><span className="bound-quote">{highlightBoundValues(boundFact.sourceExcerpt,boundFact)}</span></p>}
          {linked.has(item.id)&&<p className="evidence-link"><span>↳</span> Linked to selected claim</p>}
        </article>)}</div>
      </div>
    </section>

    <section id="agent-availability" className={`agent-handoff ${lastToolEvent&&!lastToolEvent.ok?"handoff-denied":""}`} aria-labelledby="handoff-title">
      <div><p id="handoff-title" className="kicker">{lastToolEvent?"Agent activity":"Agent availability"}</p><strong>{webMcpReady?(lastToolEvent?(lastToolEvent.tool==="review_propose_revision"?"Agent staged a correction — compiler preview is ready":"Agent completed a workspace step"):"WebMCP tools are ready for a browser agent."):toolStatus==="registering"?"Preparing WebMCP tools…":"Manual review is available without WebMCP."}</strong></div>
      <div>{lastToolEvent?<p>{lastToolEvent.message} <small className="technical-receipt">{lastToolEvent.tool} · workspace r{lastToolEvent.workspaceRevision}</small></p>:webMcpReady?<p>Paste the copied prompt into your browser agent. It can inspect shared evidence and stage work, but cannot approve or export.</p>:<details className="webmcp-help"><summary>Connect a browser agent</summary><ol><li>Open this same URL in Chrome 149 or newer.</li><li>Open <code>chrome://flags/#enable-webmcp-testing</code>.</li><li>Enable the flag and fully relaunch Chrome.</li><li>Reload this page. It will show “WebMCP ready” when the browser exposes the API.</li></ol><p>This browser capability is optional; the manual review path remains available.</p></details>}</div>
      <div className="handoff-next"><span>{webMcpReady?`${toolCount} WEBMCP TOOL${toolCount===1?"":"S"} AVAILABLE`:"MANUAL REVIEW MODE"}</span><strong>{release.ready?"Verified export available":"Verified export unavailable"}</strong></div>
    </section>

    {proposal&&<section className="proposal-tray" aria-labelledby="proposal-title" aria-live="polite">
      <div><p className="kicker">Human checkpoint / proposal {proposal.id}</p><h2 id="proposal-title" ref={proposalHeadingRef} tabIndex={-1}>{proposalStale?"Proposal is stale":"Revision staged, not applied"}</h2><p>{proposalStale?"The workspace changed after this proposal was staged. Dismiss it and ask the agent to stage a new revision.":proposal.reason}</p></div>
      <div className="proposal-copy"><blockquote>{proposal.proposedText}</blockquote>{proposalPreview&&<div className={`proposal-preview preview-${proposalPreview.status}`}><strong>Compiler preview: {proposalPreview.status.toUpperCase()}</strong><span>{proposalPreview.checks.filter((item)=>item.status==="fail").length?`${proposalPreview.checks.filter((item)=>item.status==="fail").length} deterministic check${proposalPreview.checks.filter((item)=>item.status==="fail").length===1?"":"s"} would fail.`:"All deterministic checks would pass. Human approval is still required."}</span></div>}</div>
      <div className="proposal-actions"><button className="reject" onClick={()=>mutate((current)=>decideProposal(current,proposal.id,"rejected"),proposalStale?"Stale proposal dismissed by human.":"Revision rejected by human.")}>{proposalStale?"Dismiss stale proposal":"Reject revision"}</button><button className="approve" disabled={proposalStale} onClick={()=>mutate((current)=>decideProposal(current,proposal.id,"accepted"),proposalPreview?.status==="pass"?"Correction applied. Confirm the compiled finding separately to unlock release.":"Correction applied; the claim remains blocked until its checks pass.")}>{proposalPreview?.status==="pass"?"Apply correction":"Apply correction — claim stays blocked"}</button></div>
    </section>}

    <section className="activity-ledger"><div><p className="kicker">Review history</p><h2>What changed</h2><p className="ledger-count">All {workspace.activity.length} recorded events</p></div><ol>{[...workspace.activity].reverse().map((item)=><li key={item.id}><span className={`actor actor-${item.actor}`}>{item.actor}</span><span>{item.message}</span><code>r{item.revision}</code></li>)}</ol></section>
  </main>{builderMode&&<ReviewBuilder mode={builderMode} workspace={workspace} selectedClaimId={claim.id} onClose={()=>setBuilderMode(null)} onApply={applyBuiltWorkspace}/>}</>;
}
