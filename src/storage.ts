import { exampleWorkspace, type QuantitativeAssertion, type Workspace } from "./domain";

export const WORKSPACE_STORAGE_KEY="evidence-workspace.v1";
export const CORRUPT_STORAGE_KEY="evidence-workspace.corrupt";

interface StorageLike { getItem:(key:string)=>string|null; setItem:(key:string,value:string)=>void }
export interface WorkspaceLoadResult { workspace:Workspace; warning:string|null; source:"default"|"storage"|"recovered" }
export type WorkspaceParseResult={ok:true;workspace:Workspace}|{ok:false;error:string};

const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const string=(value:unknown)=>typeof value==="string";
const finite=(value:unknown)=>typeof value==="number"&&Number.isFinite(value);
const safeInteger=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value);
const stringArray=(value:unknown)=>Array.isArray(value)&&value.every(string);
const handle=(value:unknown)=>typeof value==="string"&&/^[A-Za-z0-9._-]{1,80}$/.test(value);
const cloneExample=():Workspace=>structuredClone(exampleWorkspace);

function validAssertion(value:unknown):value is QuantitativeAssertion{
  if(!record(value)||!string(value.metric)||!value.metric.trim()||!string(value.unit)||!value.unit.trim()||!string(value.sourceWindow)||!value.sourceWindow.trim()) return false;
  if(value.kind==="percentage_change") return finite(value.claimedPercent);
  if(value.kind==="before_after") return finite(value.baseline)&&finite(value.observed);
  if(value.kind==="scalar") return finite(value.claimedValue);
  return false;
}

function normalizeLegacyFacts(value:unknown):unknown{
  if(!record(value)||!Array.isArray(value.evidence)) return value;
  return {...value,evidence:value.evidence.map((item)=>record(item)&&Array.isArray(item.facts)?{...item,facts:item.facts.map((fact)=>record(fact)&&fact.kind===undefined&&finite(fact.baseline)&&finite(fact.observed)?{...fact,kind:"range"}:fact)}:item)};
}

function validWorkspace(value:unknown):value is Workspace{
  if(!record(value)||value.schemaVersion!==1||!safeInteger(value.revision)||(value.revision as number)<1||(value.revision as number)>=Number.MAX_SAFE_INTEGER||(value.title!==undefined&&!string(value.title))) return false;
  if(!Array.isArray(value.claims)||value.claims.length===0||!Array.isArray(value.evidence)||!Array.isArray(value.proposals)||!Array.isArray(value.activity)) return false;
  const claims=value.claims.every((claim)=>record(claim)&&handle(claim.id)&&string(claim.text)&&["unreviewed","supported","contradicted","unsupported"].includes(claim.state as string)&&stringArray(claim.linkedEvidenceIds)&&(claim.linkedEvidenceIds as unknown[]).every(handle)&&(claim.rationale===null||string(claim.rationale))&&["pending","approved","rejected"].includes(claim.humanDecision as string)&&validAssertion(claim.assertion));
  const evidence=value.evidence.every((item)=>record(item)&&handle(item.id)&&string(item.title)&&string(item.sourceLabel)&&string(item.passage)&&typeof item.sharedWithAgent==="boolean"&&["primary","supporting","unknown"].includes(item.kind as string)&&Array.isArray(item.facts)&&item.facts.every((fact)=>record(fact)&&string(fact.metric)&&string(fact.unit)&&string(fact.sourceWindow)&&string(fact.sourceExcerpt)&&(fact.kind==="range"?finite(fact.baseline)&&finite(fact.observed):fact.kind==="scalar"&&finite(fact.value))));
  const proposals=value.proposals.every((proposal)=>record(proposal)&&handle(proposal.id)&&handle(proposal.claimId)&&string(proposal.proposedText)&&(proposal.proposedAssertion===undefined||validAssertion(proposal.proposedAssertion))&&string(proposal.reason)&&["pending","accepted","rejected"].includes(proposal.state as string)&&string(proposal.createdAt)&&safeInteger(proposal.basedOnRevision)&&string(proposal.claimTextAtCreation));
  const activity=value.activity.every((item)=>record(item)&&handle(item.id)&&["human","agent","system"].includes(item.actor as string)&&string(item.message)&&safeInteger(item.revision));
  if(!claims||!evidence||!proposals||!activity) return false;
  const claimIds=new Set((value.claims as Array<{id:string}>).map((item)=>item.id));
  const evidenceIds=new Set((value.evidence as Array<{id:string}>).map((item)=>item.id));
  const proposalIds=new Set((value.proposals as Array<{id:string}>).map((item)=>item.id));
  const activityIds=(value.activity as Array<{id:string}>).map((item)=>item.id);
  const pendingClaimIds=(value.proposals as Array<{claimId:string;state:string}>).filter((item)=>item.state==="pending").map((item)=>item.claimId);
  const activityRevisions=(value.activity as Array<{revision:number}>).map((item)=>item.revision);
  const activityOrderValid=activityRevisions.every((revision,index)=>revision>=1&&revision<=(value.revision as number)&&(index===0||revision>=activityRevisions[index-1]));
  const relationshipsUnique=(value.claims as Array<{linkedEvidenceIds:string[]}>).every((claim)=>new Set(claim.linkedEvidenceIds).size===claim.linkedEvidenceIds.length);
  const referencesValid=(value.claims as Array<{linkedEvidenceIds:string[]}>).every((claim)=>claim.linkedEvidenceIds.every((id)=>evidenceIds.has(id)))&&(value.proposals as Array<{claimId:string;state:string;basedOnRevision:number;claimTextAtCreation:string}>).every((proposal)=>{const claim=(value.claims as Array<{id:string;text:string}>).find((item)=>item.id===proposal.claimId);return Boolean(claim)&&proposal.basedOnRevision>=1&&proposal.basedOnRevision<=(value.revision as number)&&(proposal.state!=="pending"||(proposal.basedOnRevision===value.revision&&proposal.claimTextAtCreation===claim?.text))});
  return claimIds.size===value.claims.length&&evidenceIds.size===value.evidence.length&&proposalIds.size===value.proposals.length&&new Set(activityIds).size===activityIds.length&&relationshipsUnique&&new Set(pendingClaimIds).size===pendingClaimIds.length&&activityOrderValid&&referencesValid;
}

function normalizedWorkspace(value:Workspace):Workspace{
  const assertion=(item:QuantitativeAssertion):QuantitativeAssertion=>item.kind==="percentage_change"?{kind:item.kind,metric:item.metric,claimedPercent:item.claimedPercent,unit:item.unit,sourceWindow:item.sourceWindow}:item.kind==="before_after"?{kind:item.kind,metric:item.metric,baseline:item.baseline,observed:item.observed,unit:item.unit,sourceWindow:item.sourceWindow}:{kind:item.kind,metric:item.metric,claimedValue:item.claimedValue,unit:item.unit,sourceWindow:item.sourceWindow};
  return {schemaVersion:1,revision:value.revision,...(value.title===undefined?{}:{title:value.title}),claims:value.claims.map((item)=>({id:item.id,text:item.text,state:item.state,linkedEvidenceIds:[...item.linkedEvidenceIds],rationale:item.rationale,humanDecision:item.humanDecision,assertion:assertion(item.assertion)})),evidence:value.evidence.map((item)=>({id:item.id,title:item.title,sourceLabel:item.sourceLabel,passage:item.passage,sharedWithAgent:item.sharedWithAgent,kind:item.kind,facts:item.facts.map((fact)=>fact.kind==="range"?{kind:fact.kind,metric:fact.metric,unit:fact.unit,sourceWindow:fact.sourceWindow,sourceExcerpt:fact.sourceExcerpt,baseline:fact.baseline,observed:fact.observed}:{kind:fact.kind,metric:fact.metric,unit:fact.unit,sourceWindow:fact.sourceWindow,sourceExcerpt:fact.sourceExcerpt,value:fact.value})})),proposals:value.proposals.map((item)=>({id:item.id,claimId:item.claimId,proposedText:item.proposedText,...(item.proposedAssertion===undefined?{}:{proposedAssertion:assertion(item.proposedAssertion)}),reason:item.reason,state:item.state,createdAt:item.createdAt,basedOnRevision:item.basedOnRevision,claimTextAtCreation:item.claimTextAtCreation})),activity:value.activity.map((item)=>({id:item.id,actor:item.actor,message:item.message,revision:item.revision}))};
}

export function loadWorkspace(storage:StorageLike):WorkspaceLoadResult{
  let raw:string|null;
  try{raw=storage.getItem(WORKSPACE_STORAGE_KEY)}catch(error){return {workspace:cloneExample(),warning:error instanceof Error?`Browser storage is unavailable; changes will remain in memory for this session. ${error.message}`:"Browser storage is unavailable; changes will remain in memory for this session.",source:"recovered"}}
  if(raw===null) return {workspace:cloneExample(),warning:null,source:"default"};
  const parsed=parseWorkspaceJson(raw);
  if(parsed.ok) return {workspace:parsed.workspace,warning:null,source:"storage"};
  else{
    try{storage.setItem(CORRUPT_STORAGE_KEY,raw)}catch{ /* Recovery must still show the safe fixture. */ }
    return {workspace:cloneExample(),warning:`Stored workspace was invalid and was replaced with the safe example. ${parsed.error}`,source:"recovered"};
  }
}

export function parseWorkspaceJson(raw:string):WorkspaceParseResult{
  try{const parsed:unknown=normalizeLegacyFacts(JSON.parse(raw));return validWorkspace(parsed)?{ok:true,workspace:normalizedWorkspace(parsed)}:{ok:false,error:"Workspace does not match schema version 1."}}catch(error){return {ok:false,error:error instanceof Error?error.message:"Workspace JSON could not be read."}}
}

export function saveWorkspace(storage:StorageLike,workspace:Workspace):string|null{
  try{storage.setItem(WORKSPACE_STORAGE_KEY,JSON.stringify(workspace));return null}catch(error){return error instanceof Error?`Local save failed: ${error.message}`:"Local save failed."}
}
