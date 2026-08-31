import {nextWorkspaceRevision,type Claim,type Evidence,type QuantitativeAssertion,type SourceFact,type Workspace} from "./domain";

export type AssertionKind=QuantitativeAssertion["kind"];
export interface ClaimDraft { text:string; kind:AssertionKind; metric:string; unit:string; sourceWindow:string; claimedPercent:string; baseline:string; observed:string; claimedValue:string }
export interface EvidenceDraft { title:string; sourceLabel:string; passage:string; sourceExcerpt:string; kind:Evidence["kind"]; sharedWithAgent:boolean; factKind:"range"|"scalar"; metric:string; unit:string; sourceWindow:string; baseline:string; observed:string; value:string; linkClaimId?:string }
export interface NewReviewDraft { title:string; claim:ClaimDraft; evidence:EvidenceDraft }
export interface ValidationIssue { path:string; message:string }
export type ValidationResult<T>={ok:true;value:T}|{ok:false;issues:ValidationIssue[]};

const canonicalNumber=/^-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/;
const trimmed=(value:string)=>value.trim();
const issue=(path:string,message:string):ValidationIssue=>({path,message});
const text=(issues:ValidationIssue[],path:string,value:string,min:number,max:number,label:string)=>{const clean=trimmed(value);if(clean.length<min)issues.push(issue(path,`${label} must be at least ${min} characters.`));else if(clean.length>max)issues.push(issue(path,`${label} must be ${max} characters or fewer.`));return clean};
const number=(issues:ValidationIssue[],path:string,value:string,label:string)=>{const clean=trimmed(value);if(!canonicalNumber.test(clean)){issues.push(issue(path,`${label} must be a finite number with optional standard thousands grouping.`));return null}const parsed=Number(clean.replaceAll(",",""));if(!Number.isFinite(parsed)){issues.push(issue(path,`${label} must be finite.`));return null}return parsed};
const id=(prefix:string,existing:string[])=>{let index=1;while(existing.includes(`${prefix}-${index}`))index+=1;return `${prefix}-${index}`};
const valuesInExcerpt=(excerpt:string,required:number[])=>{const tokens=excerpt.match(/-?\d[\d,]*(?:\.\d+)?/g)??[];if(tokens.some((token)=>token.includes(",")&&!/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)))return false;const values=tokens.map((token)=>Number(token.replaceAll(",","")));return required.every((requiredValue)=>values.some((value)=>Math.abs(value-requiredValue)<=0.01))};

export function buildAssertion(draft:ClaimDraft):ValidationResult<QuantitativeAssertion>{
  const issues:ValidationIssue[]=[];
  const common={metric:text(issues,"claim.metric",draft.metric,1,120,"Metric"),unit:text(issues,"claim.unit",draft.unit,1,40,"Unit"),sourceWindow:text(issues,"claim.sourceWindow",draft.sourceWindow,1,120,"Scope/window")};
  text(issues,"claim.text",draft.text,10,500,"Claim text");
  let assertion:QuantitativeAssertion|null=null;
  if(draft.kind==="percentage_change"){const claimedPercent=number(issues,"claim.claimedPercent",draft.claimedPercent,"Claimed percentage");if(claimedPercent!==null)assertion={kind:draft.kind,...common,claimedPercent}}
  if(draft.kind==="before_after"){const baseline=number(issues,"claim.baseline",draft.baseline,"Claim baseline");const observed=number(issues,"claim.observed",draft.observed,"Claim observed value");if(baseline!==null&&observed!==null)assertion={kind:draft.kind,...common,baseline,observed}}
  if(draft.kind==="scalar"){const claimedValue=number(issues,"claim.claimedValue",draft.claimedValue,"Claimed value");if(claimedValue!==null)assertion={kind:draft.kind,...common,claimedValue}}
  return issues.length||!assertion?{ok:false,issues}:{ok:true,value:assertion};
}

export function buildEvidence(draft:EvidenceDraft):ValidationResult<{evidence:Omit<Evidence,"id">;fact:SourceFact}>{
  const issues:ValidationIssue[]=[];
  const title=text(issues,"evidence.title",draft.title,1,160,"Evidence title");
  const sourceLabel=text(issues,"evidence.sourceLabel",draft.sourceLabel,1,240,"Source reference");
  const passage=text(issues,"evidence.passage",draft.passage,1,20000,"Source passage");
  const sourceExcerpt=text(issues,"evidence.sourceExcerpt",draft.sourceExcerpt,1,2000,"Exact excerpt");
  const common={metric:text(issues,"evidence.metric",draft.metric,1,120,"Source metric"),unit:text(issues,"evidence.unit",draft.unit,1,40,"Source unit"),sourceWindow:text(issues,"evidence.sourceWindow",draft.sourceWindow,1,120,"Source scope/window"),sourceExcerpt};
  if(sourceExcerpt&&passage){const first=passage.indexOf(sourceExcerpt);if(first<0)issues.push(issue("evidence.sourceExcerpt","Exact excerpt must appear byte-for-byte in the source passage."));else if(passage.indexOf(sourceExcerpt,first+sourceExcerpt.length)>=0)issues.push(issue("evidence.sourceExcerpt","Exact excerpt appears more than once; choose a more specific excerpt."))}
  if(common.sourceWindow&&passage&&!passage.includes(common.sourceWindow))issues.push(issue("evidence.sourceWindow","Source scope/window must appear in the source passage."));
  let fact:SourceFact|null=null;
  if(draft.factKind==="range"){
    const baseline=number(issues,"evidence.baseline",draft.baseline,"Source baseline");const observed=number(issues,"evidence.observed",draft.observed,"Source observed value");
    if(baseline!==null&&observed!==null){if(sourceExcerpt&&!valuesInExcerpt(sourceExcerpt,[baseline,observed]))issues.push(issue("evidence.sourceExcerpt","Exact excerpt must contain both source values."));fact={kind:"range",...common,baseline,observed}}
  }else{
    const value=number(issues,"evidence.value",draft.value,"Source value");
    if(value!==null){if(sourceExcerpt&&!valuesInExcerpt(sourceExcerpt,[value]))issues.push(issue("evidence.sourceExcerpt","Exact excerpt must contain the source value."));fact={kind:"scalar",...common,value}}
  }
  if(!fact||issues.length)return {ok:false,issues};
  return {ok:true,value:{fact,evidence:{title,sourceLabel,passage,sharedWithAgent:draft.sharedWithAgent,kind:draft.kind,facts:[fact]}}};
}

function claimFrom(draft:ClaimDraft,assertion:QuantitativeAssertion,claimId:string):Claim{return {id:claimId,text:trimmed(draft.text),state:"unreviewed",linkedEvidenceIds:[],rationale:null,humanDecision:"pending",assertion}}

export function createNewReview(draft:NewReviewDraft):ValidationResult<Workspace>{
  const issues:ValidationIssue[]=[];const title=text(issues,"title",draft.title,3,160,"Report title");const assertion=buildAssertion(draft.claim);const evidence=buildEvidence(draft.evidence);
  if(!assertion.ok)issues.push(...assertion.issues);if(!evidence.ok)issues.push(...evidence.issues);
  if(assertion.ok&&evidence.ok){const expected=assertion.value.kind==="scalar"?"scalar":"range";if(evidence.value.fact.kind!==expected)issues.push(issue("evidence.factKind",`${assertion.value.kind} claims require a ${expected} source fact.`));if(assertion.value.kind==="percentage_change"&&evidence.value.fact.kind==="range"&&Math.abs(evidence.value.fact.baseline)<=0.01)issues.push(issue("evidence.baseline","Percentage change cannot be compiled from a zero baseline."))}
  if(issues.length||!assertion.ok||!evidence.ok)return {ok:false,issues};
  const claim=claimFrom(draft.claim,assertion.value,"claim-1");claim.linkedEvidenceIds=["evidence-1"];
  return {ok:true,value:{schemaVersion:1,revision:1,title,claims:[claim],evidence:[{id:"evidence-1",...evidence.value.evidence}],proposals:[],activity:[{id:"event-1",actor:"human",message:"Created a new local review with one linked source.",revision:1}]}};
}

export function addClaim(workspace:Workspace,draft:ClaimDraft):ValidationResult<Workspace>{
  const assertion=buildAssertion(draft);if(!assertion.ok)return assertion;
  const claimId=id("claim",workspace.claims.map((item)=>item.id));let revision:number;try{revision=nextWorkspaceRevision(workspace)}catch(error){return {ok:false,issues:[issue("workspace.revision",error instanceof Error?error.message:"Workspace revision limit reached.")]}};
  return {ok:true,value:{...workspace,revision,claims:[...workspace.claims,claimFrom(draft,assertion.value,claimId)],activity:[...workspace.activity,{id:`event-${revision}-${workspace.activity.length+1}`,actor:"human",message:`Added ${claimId} to the local review.`,revision}]}};
}

export function updateClaim(workspace:Workspace,claimId:string,draft:ClaimDraft):ValidationResult<Workspace>{
  const current=workspace.claims.find((item)=>item.id===claimId);
  if(!current)return {ok:false,issues:[issue("claim.id","Claim not found.")]};
  if(workspace.proposals.some((item)=>item.claimId===claimId&&item.state==="pending"))return {ok:false,issues:[issue("claim.id","Decide or dismiss the pending proposal before editing this claim.")]};
  const assertion=buildAssertion(draft);if(!assertion.ok)return assertion;
  let revision:number;try{revision=nextWorkspaceRevision(workspace)}catch(error){return {ok:false,issues:[issue("workspace.revision",error instanceof Error?error.message:"Workspace revision limit reached.")]}};
  return {ok:true,value:{...workspace,revision,claims:workspace.claims.map((item)=>item.id===claimId?{...item,text:trimmed(draft.text),assertion:assertion.value,state:"unreviewed",rationale:null,humanDecision:"pending"}:item),activity:[...workspace.activity,{id:`event-${revision}-${workspace.activity.length+1}`,actor:"human",message:`Edited ${claimId}; prior review decisions were invalidated.`,revision}]}};
}

export function addEvidence(workspace:Workspace,draft:EvidenceDraft):ValidationResult<Workspace>{
  const built=buildEvidence(draft);if(!built.ok)return built;
  if(draft.linkClaimId&&!workspace.claims.some((claim)=>claim.id===draft.linkClaimId))return {ok:false,issues:[issue("evidence.linkClaimId","Selected claim does not exist.")]};
  const evidenceId=id("evidence",workspace.evidence.map((item)=>item.id));let revision:number;try{revision=nextWorkspaceRevision(workspace)}catch(error){return {ok:false,issues:[issue("workspace.revision",error instanceof Error?error.message:"Workspace revision limit reached.")]}};
  return {ok:true,value:{...workspace,revision,evidence:[...workspace.evidence,{id:evidenceId,...built.value.evidence}],claims:workspace.claims.map((claim)=>claim.id===draft.linkClaimId?{...claim,linkedEvidenceIds:[...claim.linkedEvidenceIds,evidenceId],state:"unreviewed",rationale:null,humanDecision:"pending"}:claim),activity:[...workspace.activity,{id:`event-${revision}-${workspace.activity.length+1}`,actor:"human",message:`Added ${evidenceId}${draft.linkClaimId?` and linked it to ${draft.linkClaimId}; prior decisions were invalidated`:""}.`,revision}]}};
}
