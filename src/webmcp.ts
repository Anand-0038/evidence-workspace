import { compileClaimVerification, compileProposalPreview, createExportPacket, flagClaim, getReleaseCheck, linkEvidence, proposeRevision, unlinkEvidence, type ClaimState, type QuantitativeAssertion, type SourceFact, type Workspace } from "./domain";

type WorkspaceReader=()=>Workspace;
type WorkspaceWriter=(workspace:Workspace)=>void;
type ToolResult={ok:boolean;workspaceRevision:number;message:string;[key:string]:unknown};
export interface SiteToolEvent { tool:string; ok:boolean; workspaceRevision:number; message:string; outcome:string }
export interface SiteToolRuntime { abort:()=>void; reconcileExport:()=>Promise<void>; registeredToolCount:()=>number }

const emptySchema={type:"object",properties:{},additionalProperties:false};
const revisionProperty={type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:"Current workspace revision shown by a read tool."};
const claimIdProperty={type:"string",minLength:1,maxLength:80,description:"Exact claim ID returned by review_list_claims."};
const evidenceIdProperty={type:"string",minLength:1,maxLength:80,description:"Exact evidence ID returned by review_list_shared_evidence or claim context."};
const proposedAssertionProperty={type:"object",description:"Optional complete typed assertion for the proposed wording. Include it when quantitative values or scope change.",properties:{kind:{type:"string",enum:["percentage_change","before_after","scalar"]},metric:{type:"string",minLength:1,maxLength:120},claimedPercent:{type:"number"},baseline:{type:"number"},observed:{type:"number"},claimedValue:{type:"number"},unit:{type:"string",minLength:1,maxLength:40},sourceWindow:{type:"string",minLength:1,maxLength:120}},required:["kind","metric","unit","sourceWindow"],additionalProperties:false};

function result(workspace:Workspace,message:string,extra:Record<string,unknown>={}):ToolResult{
  return {ok:true,workspaceRevision:workspace.revision,message,...extra};
}

function stale(workspace:Workspace,expectedRevision:number):ToolResult|null{
  return Number.isSafeInteger(expectedRevision)&&expectedRevision===workspace.revision?null:{ok:false,workspaceRevision:workspace.revision,message:`Stale workspace. Expected revision ${expectedRevision}; current revision is ${workspace.revision}. Read state again before writing.`,code:"STALE_REVISION",nextAction:"Call review_get_summary, then retry with its workspaceRevision.",humanActionRequired:false};
}
const canceled=(workspace:Workspace):ToolResult=>({ok:false,workspaceRevision:workspace.revision,message:"Tool call canceled before mutation.",code:"CANCELED",nextAction:"Read the current workspace state before deciding whether to retry.",humanActionRequired:false});
const failure=(workspace:Workspace,error:unknown,fallback:string):ToolResult=>{const message=error instanceof Error?error.message:fallback;const known=message.includes("not shared")?{code:"EVIDENCE_NOT_SHARED",nextAction:"Ask the human to share this evidence in the page, then reread shared evidence.",humanActionRequired:true}:message.includes("already linked")?{code:"ALREADY_LINKED",nextAction:"Call review_get_claim_context; do not repeat the link.",humanActionRequired:false}:message.includes("already pending")?{code:"PROPOSAL_PENDING",nextAction:"Stop and wait for the human to decide or dismiss the pending proposal.",humanActionRequired:true}:message.includes("Claim not found")?{code:"CLAIM_NOT_FOUND",nextAction:"Call review_list_claims and use an exact returned claim ID.",humanActionRequired:false}:message.includes("Evidence not found")?{code:"EVIDENCE_NOT_FOUND",nextAction:"Call review_list_shared_evidence and use an exact returned evidence ID.",humanActionRequired:false}:message.includes("cannot be marked supported")?{code:"CHECKS_NOT_PASSING",nextAction:"Call review_run_checks and address its first failing check.",humanActionRequired:false}:{code:"OPERATION_FAILED",nextAction:"Read the current workspace state and follow the reported prerequisite.",humanActionRequired:false};return {ok:false,workspaceRevision:workspace.revision,message,...known}};
const factSummary=(fact:SourceFact)=>({metric:fact.metric,unit:fact.unit,sourceWindow:fact.sourceWindow,values:fact.kind==="range"?{kind:"range",baseline:fact.baseline,observed:fact.observed}:{kind:"scalar",value:fact.value}});
const assertionCopy=(assertion:QuantitativeAssertion):QuantitativeAssertion=>assertion.kind==="percentage_change"?{kind:assertion.kind,metric:assertion.metric,claimedPercent:assertion.claimedPercent,unit:assertion.unit,sourceWindow:assertion.sourceWindow}:assertion.kind==="before_after"?{kind:assertion.kind,metric:assertion.metric,baseline:assertion.baseline,observed:assertion.observed,unit:assertion.unit,sourceWindow:assertion.sourceWindow}:{kind:assertion.kind,metric:assertion.metric,claimedValue:assertion.claimedValue,unit:assertion.unit,sourceWindow:assertion.sourceWindow};
const bounded=(value:unknown,label:string,max:number)=>{if(typeof value!=="string"||!value.trim()||value.trim().length>max)throw new Error(`${label} must be 1–${max} characters.`);return value.trim()};

function parseAssertion(value:unknown):QuantitativeAssertion|undefined{
  if(value===undefined) return undefined;
  if(!value||typeof value!=="object") throw new Error("Proposed assertion must be an object.");
  const input=value as Record<string,unknown>;
  const metric=bounded(input.metric,"Metric",120),unit=bounded(input.unit,"Unit",40),sourceWindow=bounded(input.sourceWindow,"Source window",120);
  if(input.kind==="percentage_change"&&typeof input.claimedPercent==="number"&&Number.isFinite(input.claimedPercent)) return {kind:"percentage_change",metric,claimedPercent:input.claimedPercent,unit,sourceWindow};
  if(input.kind==="before_after"&&typeof input.baseline==="number"&&Number.isFinite(input.baseline)&&typeof input.observed==="number"&&Number.isFinite(input.observed)) return {kind:"before_after",metric,baseline:input.baseline,observed:input.observed,unit,sourceWindow};
  if(input.kind==="scalar"&&typeof input.claimedValue==="number"&&Number.isFinite(input.claimedValue)) return {kind:"scalar",metric,claimedValue:input.claimedValue,unit,sourceWindow};
  throw new Error("Proposed assertion is missing the numeric fields required by its kind.");
}

export async function registerSiteTools(read:WorkspaceReader,write:WorkspaceWriter,onToolEvent?:(event:SiteToolEvent)=>void):Promise<SiteToolRuntime|null>{
  if(typeof document.modelContext?.registerTool!=="function") return null;
  const coreController=new AbortController();
  let exportController:AbortController|null=null;
  let exportRegistered=false;
  let exportRegistration:Promise<void>|null=null;
  let reconcileQueue=Promise.resolve();
  let coreToolCount=0;
  const abortExport=()=>{const active=exportController as AbortController|null;if(active)active.abort();exportController=null;exportRegistered=false};
  const instrument=(tool:WebMCP.ModelContextTool):WebMCP.ModelContextTool=>({...tool,execute:async(input,options)=>{const response=await tool.execute(input,options);if(response&&typeof response==="object"){const value=response as Partial<ToolResult>&{verification?:{status?:string};preview?:{status?:string}};if(typeof value.ok==="boolean"&&typeof value.workspaceRevision==="number"&&typeof value.message==="string"){const outcome=!value.ok?"DENIED":value.preview?.status?`STAGED / PREVIEW ${value.preview.status.toUpperCase()}`:value.verification?.status?`COMPILER ${value.verification.status.toUpperCase()}`:"COMPLETED";onToolEvent?.({tool:tool.name,ok:value.ok,workspaceRevision:value.workspaceRevision,message:value.message,outcome})}}return response}});
  const register=async(tool:WebMCP.ModelContextTool)=>{await document.modelContext!.registerTool(instrument(tool),{signal:coreController.signal});coreToolCount+=1};
  const performReconcile=async()=>{
    const ready=getReleaseCheck(read()).ready;
    if(!ready){abortExport();return}
    if(exportRegistered)return;
    if(exportRegistration){await exportRegistration;return}
    if(!exportController){
      const nextController=new AbortController();
      exportController=nextController;
      const registration=document.modelContext!.registerTool(instrument({name:"review_export_packet",title:"Read verified release packet",description:"Return the verified Markdown packet and machine-readable compiler manifest. Registered only while every release invariant passes. Never downloads, publishes, or changes state.",inputSchema:emptySchema,annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async()=>{const workspace=read();try{return result(workspace,"Verified packet compiled. No file was downloaded or published.",{packet:createExportPacket(workspace)})}catch(error){return failure(workspace,error,"Export is locked.")}}}),{signal:nextController.signal}).then(()=>{if(exportController===nextController&&!nextController.signal.aborted&&getReleaseCheck(read()).ready)exportRegistered=true;else nextController.abort()}).catch((error)=>{if(!nextController.signal.aborted)throw error}).finally(()=>{if(exportController===nextController&&!exportRegistered)exportController=null;if(exportRegistration===registration)exportRegistration=null});
      exportRegistration=registration;
      await registration;
    }
  };
  const reconcileExport=()=>{if(!getReleaseCheck(read()).ready)abortExport();const next=reconcileQueue.then(performReconcile,performReconcile);reconcileQueue=next.catch(()=>{});return next};
  const reconcileAfterCommit=()=>{void reconcileExport().catch((error)=>console.error("WebMCP export registration reconciliation failed after a committed workspace write.",error))};

  try{await Promise.all([
    register({
      name:"review_get_summary",title:"Get release summary",description:"Read the report revision, review counts, release stage, blockers, and evidence-sharing counts. Does not return source passages.",inputSchema:emptySchema,annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async()=>{const workspace=read();const release=getReleaseCheck(workspace);return result(workspace,"Release summary read.",{release,claimCounts:Object.fromEntries(["unreviewed","supported","contradicted","unsupported"].map((state)=>[state,workspace.claims.filter((claim)=>claim.state===state).length])),sharedEvidence:workspace.evidence.filter((item)=>item.sharedWithAgent).length,totalEvidence:workspace.evidence.length})}
    }),
    register({
      name:"review_list_claims",title:"List report claims",description:"List claim IDs, exact draft wording, review state, linked evidence IDs, and human-decision state for the open report.",inputSchema:emptySchema,annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async()=>{const workspace=read();const claims=workspace.claims.map((claim)=>({id:claim.id,text:claim.text,state:claim.state,linkedEvidenceIds:[...claim.linkedEvidenceIds],rationale:claim.rationale,humanDecision:claim.humanDecision,assertion:assertionCopy(claim.assertion)}));return result(workspace,"Claims read.",{claims})}
    }),
    register({
      name:"review_list_shared_evidence",title:"List evidence shared with site tools",description:"List minimal metadata and typed fact summaries for evidence the human currently permits WebMCP tools to use. Evidence not shared with site tools and exact passages are not returned.",inputSchema:emptySchema,annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async()=>{const workspace=read();const evidence=workspace.evidence.filter((item)=>item.sharedWithAgent).map((item)=>({id:item.id,title:item.title,sourceLabel:item.sourceLabel,kind:item.kind,facts:item.facts.map(factSummary)}));return result(workspace,evidence.length?"Human-shared evidence summaries read. Link a candidate to inspect its exact excerpt in claim context.":"No evidence is shared. Ask the human to share an evidence item in the page.",{evidence})}
    }),
    register({
      name:"review_get_claim_context",title:"Inspect claim context",description:"Read one claim and passages from evidence the human currently shares with site tools. Other evidence is excluded from this tool response.",inputSchema:{type:"object",properties:{claimId:claimIdProperty},required:["claimId"],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async(input)=>{const workspace=read();const sourceClaim=workspace.claims.find((item)=>item.id===input.claimId);if(!sourceClaim)return failure(workspace,new Error("Claim not found."),"Claim not found.");const claim={id:sourceClaim.id,text:sourceClaim.text,state:sourceClaim.state,linkedEvidenceIds:[...sourceClaim.linkedEvidenceIds],rationale:sourceClaim.rationale,humanDecision:sourceClaim.humanDecision,assertion:assertionCopy(sourceClaim.assertion)};const sharedEvidence=workspace.evidence.filter((item)=>item.sharedWithAgent&&claim.linkedEvidenceIds.includes(item.id)).map((item)=>({id:item.id,title:item.title,sourceLabel:item.sourceLabel,passage:item.passage,kind:item.kind,facts:item.facts.map((fact)=>fact.kind==="range"?{kind:fact.kind,metric:fact.metric,unit:fact.unit,sourceWindow:fact.sourceWindow,sourceExcerpt:fact.sourceExcerpt,baseline:fact.baseline,observed:fact.observed}:{kind:fact.kind,metric:fact.metric,unit:fact.unit,sourceWindow:fact.sourceWindow,sourceExcerpt:fact.sourceExcerpt,value:fact.value})}));return result(workspace,sharedEvidence.length?"Linked shared claim context read.":"No linked evidence is shared. Link a shared evidence item or ask the human to share one in the page.",{claim,sharedEvidence,verification:compileClaimVerification(workspace,claim.id)})}
    }),
    register({
      name:"review_run_checks",title:"Run deterministic claim checks",description:"Compile one claim against its linked, human-shared structured source facts. Returns coverage, metric, unit, scope, and arithmetic checks without changing state.",inputSchema:{type:"object",properties:{claimId:claimIdProperty},required:["claimId"],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async(input)=>{const workspace=read();try{return result(workspace,"Deterministic checks compiled without changing the workspace.",{verification:compileClaimVerification(workspace,input.claimId as string)})}catch(error){return failure(workspace,error,"Compilation failed.")}}
    }),
    register({
      name:"review_link_evidence",title:"Link evidence to claim",description:"Link one evidence item the human shared with site tools and record why it bears on the wording. Changes page state; cannot use unshared evidence.",inputSchema:{type:"object",properties:{expectedRevision:revisionProperty,claimId:claimIdProperty,evidenceId:evidenceIdProperty,rationale:{type:"string",minLength:10,maxLength:300,description:"Concise explanation of how the passage bears on the claim."}},required:["expectedRevision","claimId","evidenceId","rationale"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},
      execute:async(input,options)=>{const workspace=read();if(options?.signal?.aborted)return canceled(workspace);const conflict=stale(workspace,input.expectedRevision as number);if(conflict)return conflict;try{const next=linkEvidence(workspace,input.claimId as string,input.evidenceId as string,input.rationale as string);if(options?.signal?.aborted)return canceled(workspace);write(next);reconcileAfterCommit();return result(next,"Evidence linked. The page now shows the relationship.",{claimId:input.claimId,evidenceId:input.evidenceId})}catch(error){return failure(workspace,error,"Link failed.")}}
    }),
    register({
      name:"review_unlink_evidence",title:"Unlink evidence from claim",description:"Remove one evidence relationship from a claim. Changes page state and invalidates prior agent and human review decisions for that claim.",inputSchema:{type:"object",properties:{expectedRevision:revisionProperty,claimId:claimIdProperty,evidenceId:evidenceIdProperty,rationale:{type:"string",minLength:10,maxLength:300,description:"Concise explanation of why this evidence relationship should be removed."}},required:["expectedRevision","claimId","evidenceId","rationale"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},
      execute:async(input,options)=>{const workspace=read();if(options?.signal?.aborted)return canceled(workspace);const conflict=stale(workspace,input.expectedRevision as number);if(conflict)return conflict;try{const next=unlinkEvidence(workspace,input.claimId as string,input.evidenceId as string,input.rationale as string);if(options?.signal?.aborted)return canceled(workspace);write(next);reconcileAfterCommit();return result(next,"Evidence unlinked. Prior review decisions for the claim are now pending again.",{claimId:input.claimId,evidenceId:input.evidenceId})}catch(error){return failure(workspace,error,"Unlink failed.")}}
    }),
    register({
      name:"review_flag_claim",title:"Record compiled claim state",description:"Record a supported, contradicted, or unsupported review state. A supported state is rejected unless every deterministic check passes. Cannot approve a revision or unlock release by itself.",inputSchema:{type:"object",properties:{expectedRevision:revisionProperty,claimId:claimIdProperty,state:{type:"string",enum:["supported","contradicted","unsupported"],description:"Evidence review state to apply."},rationale:{type:"string",minLength:10,maxLength:300,description:"Evidence-based reason for this review state."}},required:["expectedRevision","claimId","state","rationale"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},
      execute:async(input,options)=>{const workspace=read();if(options?.signal?.aborted)return canceled(workspace);const conflict=stale(workspace,input.expectedRevision as number);if(conflict)return conflict;try{const next=flagClaim(workspace,input.claimId as string,input.state as Exclude<ClaimState,"unreviewed">,input.rationale as string);if(options?.signal?.aborted)return canceled(workspace);write(next);reconcileAfterCommit();return result(next,"Claim state updated. Human approval is unchanged.",{claimId:input.claimId,state:input.state})}catch(error){return failure(workspace,error,"Flag failed.")}}
    }),
    register({
      name:"review_propose_revision",title:"Stage claim revision",description:"Stage replacement wording and, when values change, a complete typed assertion. The proposal remains pending until the human approves or rejects it in the interface.",inputSchema:{type:"object",properties:{expectedRevision:revisionProperty,claimId:claimIdProperty,proposedText:{type:"string",minLength:10,maxLength:500,description:"Complete replacement claim wording."},reason:{type:"string",minLength:10,maxLength:300,description:"Why this wording better matches the evidence."},proposedAssertion:proposedAssertionProperty},required:["expectedRevision","claimId","proposedText","reason"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},
      execute:async(input,options)=>{const workspace=read();if(options?.signal?.aborted)return canceled(workspace);const conflict=stale(workspace,input.expectedRevision as number);if(conflict)return conflict;try{const next=proposeRevision(workspace,input.claimId as string,input.proposedText as string,input.reason as string,parseAssertion(input.proposedAssertion));const proposalId=next.proposals.at(-1)!.id;const preview=compileProposalPreview(next,proposalId);if(options?.signal?.aborted)return canceled(workspace);write(next);reconcileAfterCommit();return result(next,"Revision staged with a deterministic compiler preview for human decision. It has not been applied.",{claimId:input.claimId,proposalId,preview})}catch(error){return failure(workspace,error,"Proposal failed.")}}
    }),
    register({
      name:"review_get_release_check",title:"Check release readiness",description:"Read whether export is unlocked and the exact remaining blockers. This tool never changes state and cannot approve or publish the report.",inputSchema:emptySchema,annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async()=>{const workspace=read();return result(workspace,"Release readiness checked.",{release:getReleaseCheck(workspace)})}
    })
  ]);await reconcileExport()}catch(error){coreController.abort();abortExport();throw error}
  return {abort:()=>{coreController.abort();abortExport()},reconcileExport,registeredToolCount:()=>coreToolCount+(exportRegistered?1:0)};
}
