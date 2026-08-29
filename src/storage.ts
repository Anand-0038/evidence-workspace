import { exampleWorkspace, type QuantitativeAssertion, type Workspace } from "./domain";

export const WORKSPACE_STORAGE_KEY="evidence-workspace.v1";
export const CORRUPT_STORAGE_KEY="evidence-workspace.corrupt";

interface StorageLike { getItem:(key:string)=>string|null; setItem:(key:string,value:string)=>void }
export interface WorkspaceLoadResult { workspace:Workspace; warning:string|null; source:"default"|"storage"|"recovered" }
export type WorkspaceParseResult={ok:true;workspace:Workspace}|{ok:false;error:string};

const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const string=(value:unknown)=>typeof value==="string";
const finite=(value:unknown)=>typeof value==="number"&&Number.isFinite(value);
const stringArray=(value:unknown)=>Array.isArray(value)&&value.every(string);
const cloneExample=():Workspace=>structuredClone(exampleWorkspace);

function validAssertion(value:unknown):value is QuantitativeAssertion{
  if(!record(value)||!string(value.metric)||!value.metric.trim()||!string(value.unit)||!value.unit.trim()||!string(value.sourceWindow)||!value.sourceWindow.trim()) return false;
  if(value.kind==="percentage_change") return finite(value.claimedPercent);
  if(value.kind==="before_after") return finite(value.baseline)&&finite(value.observed);
  return false;
}

function validWorkspace(value:unknown):value is Workspace{
  if(!record(value)||value.schemaVersion!==1||!Number.isInteger(value.revision)||(value.revision as number)<1) return false;
  if(!Array.isArray(value.claims)||value.claims.length===0||!Array.isArray(value.evidence)||!Array.isArray(value.proposals)||!Array.isArray(value.activity)) return false;
  const claims=value.claims.every((claim)=>record(claim)&&string(claim.id)&&string(claim.text)&&["unreviewed","supported","contradicted","unsupported"].includes(claim.state as string)&&stringArray(claim.linkedEvidenceIds)&&(claim.rationale===null||string(claim.rationale))&&["pending","approved","rejected"].includes(claim.humanDecision as string)&&validAssertion(claim.assertion));
  const evidence=value.evidence.every((item)=>record(item)&&string(item.id)&&string(item.title)&&string(item.sourceLabel)&&string(item.passage)&&typeof item.sharedWithAgent==="boolean"&&["primary","supporting","unknown"].includes(item.kind as string)&&Array.isArray(item.facts)&&item.facts.every((fact)=>record(fact)&&string(fact.metric)&&finite(fact.baseline)&&finite(fact.observed)&&string(fact.unit)&&string(fact.sourceWindow)&&string(fact.sourceExcerpt)));
  const proposals=value.proposals.every((proposal)=>record(proposal)&&string(proposal.id)&&string(proposal.claimId)&&string(proposal.proposedText)&&(proposal.proposedAssertion===undefined||validAssertion(proposal.proposedAssertion))&&string(proposal.reason)&&["pending","accepted","rejected"].includes(proposal.state as string)&&string(proposal.createdAt)&&Number.isInteger(proposal.basedOnRevision)&&string(proposal.claimTextAtCreation));
  const activity=value.activity.every((item)=>record(item)&&string(item.id)&&["human","agent","system"].includes(item.actor as string)&&string(item.message)&&Number.isInteger(item.revision));
  if(!claims||!evidence||!proposals||!activity) return false;
  const claimIds=new Set((value.claims as Array<{id:string}>).map((item)=>item.id));
  const evidenceIds=new Set((value.evidence as Array<{id:string}>).map((item)=>item.id));
  return claimIds.size===value.claims.length&&evidenceIds.size===value.evidence.length;
}

export function loadWorkspace(storage:StorageLike):WorkspaceLoadResult{
  const raw=storage.getItem(WORKSPACE_STORAGE_KEY);
  if(raw===null) return {workspace:cloneExample(),warning:null,source:"default"};
  const parsed=parseWorkspaceJson(raw);
  if(parsed.ok) return {workspace:parsed.workspace,warning:null,source:"storage"};
  else{
    try{storage.setItem(CORRUPT_STORAGE_KEY,raw)}catch{ /* Recovery must still show the safe fixture. */ }
    return {workspace:cloneExample(),warning:`Stored workspace was invalid and was replaced with the safe example. ${parsed.error}`,source:"recovered"};
  }
}

export function parseWorkspaceJson(raw:string):WorkspaceParseResult{
  try{const parsed:unknown=JSON.parse(raw);return validWorkspace(parsed)?{ok:true,workspace:parsed}:{ok:false,error:"Workspace does not match schema version 1."}}catch(error){return {ok:false,error:error instanceof Error?error.message:"Workspace JSON could not be read."}}
}

export function saveWorkspace(storage:StorageLike,workspace:Workspace):string|null{
  try{storage.setItem(WORKSPACE_STORAGE_KEY,JSON.stringify(workspace));return null}catch(error){return error instanceof Error?`Local save failed: ${error.message}`:"Local save failed."}
}
