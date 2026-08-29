import {cloneElement,isValidElement,useEffect,useRef,useState,type FormEvent,type ReactElement,type ReactNode} from "react";
import type {Workspace} from "./domain";
import {addClaim,addEvidence,createNewReview,type AssertionKind,type ClaimDraft,type EvidenceDraft,type ValidationIssue} from "./review-builder";

export type ReviewBuilderMode="new"|"claim"|"evidence";
interface Props { mode:ReviewBuilderMode; workspace:Workspace; selectedClaimId:string; onClose:()=>void; onApply:(workspace:Workspace,message:string,selectedClaimId:string)=>void }

const blankClaim=():ClaimDraft=>({text:"",kind:"percentage_change",metric:"",unit:"",sourceWindow:"",claimedPercent:"",baseline:"",observed:"",claimedValue:""});
const blankEvidence=(claimId:string):EvidenceDraft=>({title:"",sourceLabel:"",passage:"",sourceExcerpt:"",kind:"primary",sharedWithAgent:false,factKind:"range",metric:"",unit:"",sourceWindow:"",baseline:"",observed:"",value:"",linkClaimId:claimId});
const fieldError=(issues:ValidationIssue[],path:string)=>issues.find((item)=>item.path===path)?.message;

export function ReviewBuilder({mode,workspace,selectedClaimId,onClose,onApply}:Props){
  const [reportTitle,setReportTitle]=useState("");
  const [claim,setClaim]=useState(blankClaim);
  const [evidence,setEvidence]=useState(()=>blankEvidence(selectedClaimId));
  const [issues,setIssues]=useState<ValidationIssue[]>([]);
  const dialogRef=useRef<HTMLElement>(null);
  const headingRef=useRef<HTMLHeadingElement>(null);
  const errorRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    headingRef.current?.focus();
    const handleKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();onClose();return}
      if(event.key!=="Tab")return;
      const controls=[...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')??[])].filter((item)=>item.offsetParent!==null);
      if(!controls.length){event.preventDefault();headingRef.current?.focus();return}
      const first=controls[0];const last=controls.at(-1)!;
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
    };
    document.addEventListener("keydown",handleKey);
    return()=>{document.removeEventListener("keydown",handleKey);opener?.focus()};
  },[onClose]);
  const updateClaim=<K extends keyof ClaimDraft>(key:K,value:ClaimDraft[K])=>setClaim((current)=>({...current,[key]:value}));
  const updateEvidence=<K extends keyof EvidenceDraft>(key:K,value:EvidenceDraft[K])=>setEvidence((current)=>({...current,[key]:value}));
  const chooseKind=(kind:AssertionKind)=>{updateClaim("kind",kind);if(mode==="new")updateEvidence("factKind",kind==="scalar"?"scalar":"range")};
  const submit=(event:FormEvent)=>{
    event.preventDefault();
    const result=mode==="new"?createNewReview({title:reportTitle,claim,evidence}):mode==="claim"?addClaim(workspace,claim):addEvidence(workspace,evidence);
    if(!result.ok){setIssues(result.issues);queueMicrotask(()=>errorRef.current?.focus());return}
    const selected=mode==="claim"?result.value.claims.at(-1)!.id:mode==="evidence"?(evidence.linkClaimId||selectedClaimId):result.value.claims[0].id;
    onApply(result.value,mode==="new"?"Created a new local review with one claim and one exact linked source.":mode==="claim"?"Added a claim to this local review.":"Added exact evidence to this local review.",selected);
  };
  const title=mode==="new"?"Create a new review":mode==="claim"?"Add a claim":"Add evidence";
  return <div className="builder-backdrop"><section ref={dialogRef} className="review-builder" role="dialog" aria-modal="true" aria-labelledby="builder-title">
    <header><div><p className="kicker">Human-only workspace editor</p><h2 id="builder-title" ref={headingRef} tabIndex={-1}>{title}</h2></div><button type="button" className="close-builder" aria-label="Close workspace editor" onClick={onClose}>×</button></header>
    {mode==="new"&&<p className="builder-warning"><strong>This replaces the current browser-local workspace.</strong> Export its JSON first if you need a backup. Nothing is uploaded.</p>}
    {issues.length>0&&<div className="builder-errors" role="alert" tabIndex={-1} ref={errorRef}><strong>Fix {issues.length} field{issues.length===1?"":"s"}:</strong><ul>{issues.map((item,index)=><li key={`${item.path}-${index}`}>{item.message}</li>)}</ul></div>}
    <form onSubmit={submit} noValidate>
      {mode==="new"&&<Field label="Report title" path="title" error={fieldError(issues,"title")}><input name="report_title" autoComplete="off" value={reportTitle} onChange={(event)=>setReportTitle(event.target.value)}/></Field>}
      {mode!=="evidence"&&<fieldset><legend>Claim assertion</legend>
        <Field label="Claim text" path="claim.text" error={fieldError(issues,"claim.text")}><textarea name="claim_text" rows={3} value={claim.text} onChange={(event)=>updateClaim("text",event.target.value)}/></Field>
        <div className="form-grid"><Field label="Assertion type" path="claim.kind"><select name="assertion_kind" value={claim.kind} onChange={(event)=>chooseKind(event.target.value as AssertionKind)}><option value="percentage_change">Percentage change</option><option value="before_after">Before → after</option><option value="scalar">Scalar value</option></select></Field><Field label="Metric" path="claim.metric" error={fieldError(issues,"claim.metric")}><input name="claim_metric" autoComplete="off" value={claim.metric} onChange={(event)=>updateClaim("metric",event.target.value)}/></Field><Field label="Unit" path="claim.unit" error={fieldError(issues,"claim.unit")}><input name="claim_unit" autoComplete="off" value={claim.unit} onChange={(event)=>updateClaim("unit",event.target.value)}/></Field><Field label="Scope / window" path="claim.sourceWindow" error={fieldError(issues,"claim.sourceWindow")}><input name="claim_window" autoComplete="off" value={claim.sourceWindow} onChange={(event)=>updateClaim("sourceWindow",event.target.value)}/></Field></div>
        <div className="form-grid numeric-grid">{claim.kind==="percentage_change"&&<Field label="Claimed change (%)" path="claim.claimedPercent" error={fieldError(issues,"claim.claimedPercent")}><input type="number" step="any" name="claimed_percent" value={claim.claimedPercent} onChange={(event)=>updateClaim("claimedPercent",event.target.value)}/></Field>}{claim.kind==="before_after"&&<><Field label="Claim baseline" path="claim.baseline" error={fieldError(issues,"claim.baseline")}><input type="number" step="any" name="claim_baseline" value={claim.baseline} onChange={(event)=>updateClaim("baseline",event.target.value)}/></Field><Field label="Claim observed" path="claim.observed" error={fieldError(issues,"claim.observed")}><input type="number" step="any" name="claim_observed" value={claim.observed} onChange={(event)=>updateClaim("observed",event.target.value)}/></Field></>}{claim.kind==="scalar"&&<Field label="Claimed value" path="claim.claimedValue" error={fieldError(issues,"claim.claimedValue")}><input type="number" step="any" name="claimed_value" value={claim.claimedValue} onChange={(event)=>updateClaim("claimedValue",event.target.value)}/></Field>}</div>
      </fieldset>}
      {mode!=="claim"&&<fieldset><legend>Exact evidence</legend>
        <div className="form-grid"><Field label="Source title" path="evidence.title" error={fieldError(issues,"evidence.title")}><input name="source_title" autoComplete="off" value={evidence.title} onChange={(event)=>updateEvidence("title",event.target.value)}/></Field><Field label="Source reference or URL" path="evidence.sourceLabel" error={fieldError(issues,"evidence.sourceLabel")}><input name="source_reference" autoComplete="off" value={evidence.sourceLabel} onChange={(event)=>updateEvidence("sourceLabel",event.target.value)}/></Field>{mode==="evidence"&&<Field label="Link to claim" path="evidence.linkClaimId" error={fieldError(issues,"evidence.linkClaimId")}><select name="link_claim" value={evidence.linkClaimId} onChange={(event)=>updateEvidence("linkClaimId",event.target.value)}>{workspace.claims.map((item)=><option key={item.id} value={item.id}>{item.id}: {item.text}</option>)}</select></Field>}{mode==="evidence"&&<Field label="Fact shape" path="evidence.factKind" error={fieldError(issues,"evidence.factKind")}><select name="fact_kind" value={evidence.factKind} onChange={(event)=>updateEvidence("factKind",event.target.value as EvidenceDraft["factKind"])}><option value="range">Baseline → observed</option><option value="scalar">Scalar value</option></select></Field>}</div>
        <Field label="Source passage" path="evidence.passage" error={fieldError(issues,"evidence.passage")}><textarea name="source_passage" rows={4} value={evidence.passage} onChange={(event)=>updateEvidence("passage",event.target.value)}/></Field>
        <Field label="Exact excerpt containing every source value" path="evidence.sourceExcerpt" error={fieldError(issues,"evidence.sourceExcerpt")}><textarea name="source_excerpt" rows={3} value={evidence.sourceExcerpt} onChange={(event)=>updateEvidence("sourceExcerpt",event.target.value)}/></Field>
        <div className="form-grid"><Field label="Source metric" path="evidence.metric" error={fieldError(issues,"evidence.metric")}><input name="source_metric" autoComplete="off" value={evidence.metric} onChange={(event)=>updateEvidence("metric",event.target.value)}/></Field><Field label="Source unit" path="evidence.unit" error={fieldError(issues,"evidence.unit")}><input name="source_unit" autoComplete="off" value={evidence.unit} onChange={(event)=>updateEvidence("unit",event.target.value)}/></Field><Field label="Source scope / window" path="evidence.sourceWindow" error={fieldError(issues,"evidence.sourceWindow")}><input name="source_window" autoComplete="off" value={evidence.sourceWindow} onChange={(event)=>updateEvidence("sourceWindow",event.target.value)}/></Field></div>
        <div className="form-grid numeric-grid">{evidence.factKind==="range"?<><Field label="Source baseline" path="evidence.baseline" error={fieldError(issues,"evidence.baseline")}><input type="number" step="any" name="source_baseline" value={evidence.baseline} onChange={(event)=>updateEvidence("baseline",event.target.value)}/></Field><Field label="Source observed" path="evidence.observed" error={fieldError(issues,"evidence.observed")}><input type="number" step="any" name="source_observed" value={evidence.observed} onChange={(event)=>updateEvidence("observed",event.target.value)}/></Field></>:<Field label="Source value" path="evidence.value" error={fieldError(issues,"evidence.value")}><input type="number" step="any" name="source_value" value={evidence.value} onChange={(event)=>updateEvidence("value",event.target.value)}/></Field>}</div>
        <label className="builder-checkbox"><input type="checkbox" checked={evidence.sharedWithAgent} onChange={(event)=>updateEvidence("sharedWithAgent",event.target.checked)}/><span>Share this source with site tools after creation</span></label>
      </fieldset>}
      <footer><button type="button" className="reject" onClick={onClose}>Cancel</button><button type="submit" className="approve">{mode==="new"?"Create and replace current review":mode==="claim"?"Add claim":"Add evidence"}</button></footer>
    </form>
  </section></div>;
}

function Field({label,path,error,children}:{label:string;path:string;error?:string;children:ReactNode}){const id=`builder-${path.replaceAll(".","-")}`;const control=isValidElement(children)?cloneElement(children as ReactElement<Record<string,unknown>>,{id,"aria-invalid":Boolean(error),"aria-describedby":error?`${id}-error`:undefined}):children;return <label className={`builder-field ${error?"has-error":""}`} htmlFor={id}><span>{label}</span>{control}{error&&<small id={`${id}-error`}>{error}</small>}</label>}
