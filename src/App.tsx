import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { compileClaimVerification, confirmClaim, createExportPacket, decideProposal, exampleWorkspace, getReleaseCheck, runExampleAgentReview, toggleEvidenceSharing, type Workspace } from "./domain";
import { registerSiteTools, type SiteToolRuntime } from "./webmcp";
import { loadWorkspace, parseWorkspaceJson, saveWorkspace } from "./storage";

const stages=["Draft","Evidence linked","Human reviewed","Export ready"];
const cloneExample=():Workspace=>structuredClone(exampleWorkspace);

export function App(){
  const [initialLoad]=useState(()=>loadWorkspace(window.localStorage));
  const [workspace,setWorkspace]=useState<Workspace>(initialLoad.workspace);
  const [selectedId,setSelectedId]=useState(initialLoad.workspace.claims[0]?.id??"");
  const [notice,setNotice]=useState<string|null>(initialLoad.warning);
  const [materialLabel,setMaterialLabel]=useState(initialLoad.source==="storage"?"Saved local workspace":"Example workspace");
  const [toolStatus,setToolStatus]=useState<"unavailable"|"registering"|"registered"|"error">(()=>typeof document.modelContext?.registerTool==="function"?"registering":"unavailable");
  const workspaceRef=useRef(workspace);
  const toolRuntimeRef=useRef<SiteToolRuntime|null>(null);
  const proposalHeadingRef=useRef<HTMLHeadingElement|null>(null);
  workspaceRef.current=workspace;
  const release=useMemo(()=>getReleaseCheck(workspace),[workspace]);
  const claim=workspace.claims.find((item)=>item.id===selectedId)??workspace.claims[0];
  const linked=new Set(claim.linkedEvidenceIds);
  const proposal=workspace.proposals.find((item)=>item.claimId===claim.id&&item.state==="pending");
  const verification=useMemo(()=>compileClaimVerification(workspace,claim.id),[workspace,claim.id]);

  useEffect(()=>{
    let disposed=false;
    if(typeof document.modelContext?.registerTool!=="function"){setToolStatus("unavailable");return}
    setToolStatus("registering");
    void registerSiteTools(()=>workspaceRef.current,(next)=>{workspaceRef.current=next;setWorkspace(next);setNotice("Site tool updated the workspace.")}).then((runtime)=>{if(disposed){runtime?.abort();return}toolRuntimeRef.current=runtime;setToolStatus(runtime?"registered":"unavailable")}).catch((error)=>{if(disposed)return;setToolStatus("error");setNotice(error instanceof Error?`Site tool registration failed: ${error.message}`:"Site tool registration failed.")});
    return()=>{disposed=true;toolRuntimeRef.current?.abort();toolRuntimeRef.current=null};
  },[]);

  useEffect(()=>{void toolRuntimeRef.current?.reconcileExport().catch((error)=>{setToolStatus("error");setNotice(error instanceof Error?`Export tool reconciliation failed: ${error.message}`:"Export tool reconciliation failed.")})},[workspace.revision]);
  useEffect(()=>{const warning=saveWorkspace(window.localStorage,workspace);if(warning)setNotice(warning)},[workspace]);
  useEffect(()=>{if(proposal)proposalHeadingRef.current?.focus()},[proposal?.id]);

  const mutate=(operation:(current:Workspace)=>Workspace,message?:string)=>{
    try{setWorkspace((current)=>operation(current));setNotice(message??null)}catch(error){setNotice(error instanceof Error?error.message:"The operation failed.")}
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
    try{const parsed=parseWorkspaceJson(await file.text());if(!parsed.ok){setNotice(`Import rejected: ${parsed.error}`);return}setWorkspace(parsed.workspace);setSelectedId(parsed.workspace.claims[0].id);setMaterialLabel("Imported local workspace");setNotice(`Imported ${parsed.workspace.claims.length} claims and ${parsed.workspace.evidence.length} evidence items. Review sharing permissions before using site tools.`)}catch(error){setNotice(error instanceof Error?`Import failed: ${error.message}`:"Import failed.")}
  };

  return <><a className="skip-link" href="#main-content">Skip to review workspace</a><main id="main-content" className={`app-shell ${proposal?"has-proposal":""}`}>
    <header className="masthead">
      <div>
        <p className="kicker">Release desk / revision {workspace.revision}</p>
        <h1>Can this report be published?</h1>
        <p className="subhead">Resolve every claim against exact evidence. The browser agent may stage work; only you can approve it.</p>
      </div>
      <div className="header-actions">
        <span className={`capability ${toolStatus==="registered"?"available":"unavailable"}`}>{toolStatus==="registered"?"Site tools registered":toolStatus==="registering"?"Registering site tools":toolStatus==="error"?"Site tool error":"WebMCP unavailable"}</span>
        <label className="text-button file-button">Import workspace JSON<input className="visually-hidden" type="file" accept="application/json,.json" onChange={importWorkspaceJson}/></label>
        <button className="text-button" onClick={exportWorkspaceJson}>Export workspace JSON</button>
        <button className="text-button" onClick={()=>{setWorkspace(cloneExample());setSelectedId("claim-growth");setMaterialLabel("Example workspace");setNotice("Example workspace reset.")}}>Reset example</button>
      </div>
    </header>

    <aside className="fixture-note"><strong>{materialLabel}</strong> — browser-local material. Imported facts must remain bound to exact excerpts; review sharing permissions before agent use.</aside>

    <section className={`release-rail stage-${release.stage}`} aria-labelledby="release-title">
      <div className="release-copy"><p id="release-title" className="kicker">Release invariant</p><strong>{release.ready?"Packet unlocked":"Export locked"}</strong><span>{release.ready?"Every claim is compiled and resolved.":`${release.blockers[0]}${release.blockers.length>1?` · +${release.blockers.length-1} more`:""}`}</span></div>
      <ol>{stages.map((stage,index)=><li key={stage} className={index<=release.stage?"reached":""} aria-current={index===release.stage?"step":undefined}><span>{index<release.stage?"✓":index+1}</span>{stage}</li>)}</ol>
      <button className="export-button" disabled={!release.ready} onClick={exportPacket}>Export reviewed packet</button>
    </section>

    {notice&&<div className="notice" role="status" aria-live="polite">{notice}<button aria-label="Dismiss message" onClick={()=>setNotice(null)}>×</button></div>}

    <section className="proof-table" aria-label="Claim and evidence review">
      <div className="claims-column">
        <div className="section-heading"><div><p className="kicker">Claim folio</p><h2>What the draft says</h2></div><div className="fixture-driver"><button className="agent-button" onClick={()=>mutate(runExampleAgentReview,"Fixture agent step completed. Check the compiler output.")} disabled={workspace.proposals.some((item)=>item.state==="pending")||workspace.claims.every((item)=>item.state!=="unreviewed")}>Run next fixture agent step</button><small>Local demo driver · not WebMCP proof</small></div></div>
        <ol className="claim-list">{workspace.claims.map((item,index)=><li key={item.id}><button className={item.id===claim.id?"selected":""} onClick={()=>setSelectedId(item.id)} aria-pressed={item.id===claim.id}><span className="claim-number">0{index+1}</span><span className="claim-text">{item.text}</span><span className={`state state-${item.state}`}>{item.state}</span></button></li>)}</ol>
        <article className={`claim-detail ${claim.state==="contradicted"?"is-contradicted":""}`}>
          <p className="kicker">Selected wording</p><blockquote>{claim.text}</blockquote>
          {claim.rationale&&<p className="rationale"><strong>Review note:</strong> {claim.rationale}</p>}
          <dl><div><dt>Agent review</dt><dd>{claim.state}</dd></div><div><dt>Human decision</dt><dd>{claim.humanDecision}</dd></div></dl>
          {claim.state==="supported"&&claim.humanDecision!=="approved"&&<button className="confirm-finding" onClick={()=>mutate((current)=>confirmClaim(current,claim.id),"Compiled finding confirmed by human.")}>Confirm compiled finding</button>}
        </article>
        <section className={`compiler-panel compiler-${verification.status}`} aria-labelledby="compiler-title">
          <header><div><p className="kicker">Verification compiler / manifest r{verification.workspaceRevision}</p><h2 id="compiler-title">Deterministic checks</h2></div><span className={`compiler-verdict verdict-${verification.status}`}>{verification.status}</span></header>
          <p className="compiler-boundary">Checks typed source facts, arithmetic, units, and scope. This proves internal consistency—not objective truth.</p>
          <ol>{verification.checks.map((item)=><li key={item.id} className={`check-${item.status}`}><span className="check-mark">{item.status==="pass"?"PASS":item.status==="fail"?"FAIL":"WAIT"}</span><div><strong>{item.label}</strong><p>{item.detail}</p>{(item.expected!==undefined||item.actual!==undefined)&&<code>source {String(item.expected??"—")} · claim {String(item.actual??"—")}</code>}</div></li>)}</ol>
        </section>
      </div>

      <div className="evidence-column">
        <div className="section-heading"><div><p className="kicker">Evidence sheets</p><h2>What the source says</h2></div><span className="share-count">{workspace.evidence.filter((item)=>item.sharedWithAgent).length}/{workspace.evidence.length} shared</span></div>
        <div className="evidence-stack">{workspace.evidence.map((item)=><article key={item.id} className={`evidence-sheet ${linked.has(item.id)?"linked":""}`}>
          <header><div><p className="source-label">{item.sourceLabel}</p><h3>{item.title}</h3></div><label className="share-control"><input type="checkbox" checked={item.sharedWithAgent} onChange={()=>mutate((current)=>toggleEvidenceSharing(current,item.id))}/><span>{item.sharedWithAgent?"Shared with agent":"Private"}</span></label></header>
          <blockquote>{item.passage}</blockquote>
          {linked.has(item.id)&&<p className="evidence-link"><span>↳</span> Linked to selected claim</p>}
        </article>)}</div>
      </div>
    </section>

    {proposal&&<section className="proposal-tray" aria-labelledby="proposal-title" aria-live="polite">
      <div><p className="kicker">Human checkpoint / proposal {proposal.id}</p><h2 id="proposal-title" ref={proposalHeadingRef} tabIndex={-1}>Revision staged, not applied</h2><p>{proposal.reason}</p></div>
      <blockquote>{proposal.proposedText}</blockquote>
      <div className="proposal-actions"><button className="reject" onClick={()=>mutate((current)=>decideProposal(current,proposal.id,"rejected"),"Revision rejected by human.")}>Reject revision</button><button className="approve" onClick={()=>mutate((current)=>decideProposal(current,proposal.id,"accepted"),"Revision approved by human.")}>Approve revision</button></div>
    </section>}

    <section className="activity-ledger"><div><p className="kicker">Activity ledger</p><h2>Accountable changes</h2><p className="ledger-count">All {workspace.activity.length} recorded events</p></div><ol>{[...workspace.activity].reverse().map((item)=><li key={item.id}><span className={`actor actor-${item.actor}`}>{item.actor}</span><span>{item.message}</span><code>r{item.revision}</code></li>)}</ol></section>
  </main></>;
}
