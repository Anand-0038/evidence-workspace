export type ClaimState = "unreviewed" | "supported" | "contradicted" | "unsupported";
export type HumanDecision = "pending" | "approved" | "rejected";
export type ProposalState = "pending" | "accepted" | "rejected";
export type CheckStatus = "pass" | "fail" | "blocked";

export interface PercentageChangeAssertion { kind:"percentage_change"; metric:string; claimedPercent:number; unit:string; sourceWindow:string }
export interface BeforeAfterAssertion { kind:"before_after"; metric:string; baseline:number; observed:number; unit:string; sourceWindow:string }
export interface ScalarAssertion { kind:"scalar"; metric:string; claimedValue:number; unit:string; sourceWindow:string }
export type QuantitativeAssertion = PercentageChangeAssertion | BeforeAfterAssertion | ScalarAssertion;
interface SourceFactBase { metric:string; unit:string; sourceWindow:string; sourceExcerpt:string }
export interface RangeSourceFact extends SourceFactBase { kind:"range"; baseline:number; observed:number }
export interface ScalarSourceFact extends SourceFactBase { kind:"scalar"; value:number }
export type SourceFact = RangeSourceFact | ScalarSourceFact;
export interface Evidence { id:string; title:string; sourceLabel:string; passage:string; sharedWithAgent:boolean; kind:"primary"|"supporting"|"unknown"; facts:SourceFact[] }
export interface Claim { id:string; text:string; state:ClaimState; linkedEvidenceIds:string[]; rationale:string|null; humanDecision:HumanDecision; assertion:QuantitativeAssertion }
export interface RevisionProposal { id:string; claimId:string; proposedText:string; proposedAssertion?:QuantitativeAssertion; reason:string; state:ProposalState; createdAt:string; basedOnRevision:number; claimTextAtCreation:string }
export interface ActivityEvent { id:string; actor:"human"|"agent"|"system"; message:string; revision:number }
export interface Workspace { schemaVersion:1; revision:number; title?:string; claims:Claim[]; evidence:Evidence[]; proposals:RevisionProposal[]; activity:ActivityEvent[] }
export interface VerificationCheck { id:string; label:string; status:CheckStatus; detail:string; expected?:string|number; actual?:string|number }
export interface VerificationManifest { schemaVersion:1; claimId:string; workspaceRevision:number; status:CheckStatus; sourceEvidenceIds:string[]; checks:VerificationCheck[] }
export interface ReleaseCheck { ready:boolean; stage:0|1|2|3; blockers:string[] }

export const exampleWorkspace: Workspace = {
  schemaVersion:1, revision:1,
  claims:[
    {id:"claim-growth",text:"The pilot increased weekly completed reviews by 40%.",state:"unreviewed",linkedEvidenceIds:[],rationale:null,humanDecision:"pending",assertion:{kind:"percentage_change",metric:"weekly completed reviews",claimedPercent:40,unit:"reviews/week",sourceWindow:"four weekly cycles"}},
    {id:"claim-time",text:"Median review time fell from 18 minutes to 11 minutes.",state:"unreviewed",linkedEvidenceIds:[],rationale:null,humanDecision:"pending",assertion:{kind:"before_after",metric:"median review time",baseline:18,observed:11,unit:"minutes",sourceWindow:"31 reviewed briefs"}}
  ],
  evidence:[
    {id:"evidence-pilot-note",title:"Pilot close-out note",sourceLabel:"Internal pilot note · 12 Aug 2026 · authored example",passage:"Weekly completed reviews rose from 50 to 60 during the pilot, a 20% increase. The sample covered four weekly cycles and should not be treated as a long-term forecast.",sharedWithAgent:true,kind:"primary",facts:[{kind:"range",metric:"weekly completed reviews",baseline:50,observed:60,unit:"reviews/week",sourceWindow:"four weekly cycles",sourceExcerpt:"Weekly completed reviews rose from 50 to 60 during the pilot, a 20% increase."}]},
    {id:"evidence-timing",title:"Reviewer timing table",sourceLabel:"Timing study · 14 Aug 2026 · authored example",passage:"Across 31 reviewed briefs, median handling time was 11 minutes, compared with an 18-minute baseline collected in July.",sharedWithAgent:false,kind:"primary",facts:[{kind:"range",metric:"median review time",baseline:18,observed:11,unit:"minutes",sourceWindow:"31 reviewed briefs",sourceExcerpt:"Across 31 reviewed briefs, median handling time was 11 minutes, compared with an 18-minute baseline collected in July."}]}
  ],
  proposals:[], activity:[{id:"event-open",actor:"system",message:"Example workspace opened.",revision:1}]
};

export const nextWorkspaceRevision=(workspace:Workspace)=>{const revision=workspace.revision+1;if(!Number.isSafeInteger(revision)||revision>=Number.MAX_SAFE_INTEGER)throw new Error("Workspace revision limit reached; export and start a new review.");return revision};
const nextRevision=nextWorkspaceRevision;
const event=(workspace:Workspace,actor:ActivityEvent["actor"],message:string):ActivityEvent=>({id:`event-${workspace.revision+1}-${workspace.activity.length+1}`,actor,message,revision:nextRevision(workspace)});
const normalized=(value:string)=>value.trim().toLowerCase();
const closeEnough=(left:number,right:number)=>Math.abs(left-right)<=0.01;
const rounded=(value:number)=>Math.round(value*100)/100;
const check=(id:string,label:string,status:CheckStatus,detail:string,expected?:string|number,actual?:string|number):VerificationCheck=>({id,label,status,detail,...(expected===undefined?{}:{expected}),...(actual===undefined?{}:{actual})});
const assertionValues=(assertion:QuantitativeAssertion)=>assertion.kind==="percentage_change"?[assertion.claimedPercent]:assertion.kind==="before_after"?[assertion.baseline,assertion.observed]:[assertion.claimedValue];
const unitAppears=(text:string,unit:string)=>{
  const haystack=normalized(text);
  const normalizedUnit=normalized(unit);
  const parts=normalizedUnit.split(/[^a-z0-9]+/).filter((part)=>part.length>=2).map((part)=>part.endsWith("s")?part.slice(0,-1):part);
  return parts.length>0?parts.every((part)=>haystack.includes(part)):normalizedUnit.length>0&&haystack.includes(normalizedUnit);
};
const numericValues=(text:string)=>{
  const tokens=text.match(/-?\d[\d,]*(?:\.\d+)?/g)??[];
  if(tokens.some((token)=>token.includes(",")&&!/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token))) return [Number.NaN];
  return tokens.map((token)=>Number(token.replaceAll(",","")));
};
const orderedValuesAppear=(text:string,values:number[])=>{const tokens=numericValues(text);let cursor=0;return values.every((required)=>{const offset=tokens.slice(cursor).findIndex((value)=>closeEnough(value,required));if(offset<0)return false;cursor+=offset+1;return true})};

export function compileClaimVerification(workspace:Workspace,claimId:string):VerificationManifest {
  const claim=workspace.claims.find((item)=>item.id===claimId);
  if(!claim) throw new Error("Claim not found.");
  const linkedEvidence=claim.linkedEvidenceIds.map((id)=>workspace.evidence.find((item)=>item.id===id)).filter((item):item is Evidence=>Boolean(item));
  const missingEvidenceIds=claim.linkedEvidenceIds.filter((id)=>!workspace.evidence.some((item)=>item.id===id));
  const sharedEvidence=linkedEvidence.filter((item)=>item.sharedWithAgent);
  const coveragePasses=claim.linkedEvidenceIds.length>0&&missingEvidenceIds.length===0&&sharedEvidence.length===linkedEvidence.length;
  const coverageDetail=coveragePasses?`${sharedEvidence.length} linked source${sharedEvidence.length===1?" is":"s are"} available to the compiler.`:claim.linkedEvidenceIds.length===0?"No evidence is linked to this claim.":missingEvidenceIds.length?`Missing referenced evidence: ${missingEvidenceIds.join(", ")}.`:"At least one linked source is private and cannot be compiled.";
  const claimNumbers=numericValues(claim.text);
  const typedValues=assertionValues(claim.assertion);
  const metricAppears=normalized(claim.text).includes(normalized(claim.assertion.metric));
  const valuesAppear=claim.assertion.kind==="before_after"?orderedValuesAppear(claim.text,typedValues):typedValues.every((required)=>claimNumbers.some((value)=>closeEnough(value,required)));
  const claimBindingPasses=metricAppears&&valuesAppear;
  const unitBindingPasses=unitAppears(claim.text,claim.assertion.unit);
  const relevantEvidenceIds=sharedEvidence.filter((evidence)=>evidence.facts.some((fact)=>normalized(fact.metric)===normalized(claim.assertion.metric))).map((evidence)=>evidence.id);
  const relevancePasses=coveragePasses&&relevantEvidenceIds.length===sharedEvidence.length;
  const checks:VerificationCheck[]=[
    check("source-coverage","Shared source coverage",coveragePasses?"pass":"fail",coverageDetail,"all linked sources resolved and shared",`${sharedEvidence.length}/${claim.linkedEvidenceIds.length}`),
    check("claim-binding","Claim wording binding",claimBindingPasses?"pass":"fail",claimBindingPasses?"The visible wording contains the typed metric and assertion values in semantic order.":!metricAppears?"The typed metric does not appear in the visible claim wording.":claim.assertion.kind==="before_after"?"The visible claim wording does not preserve the typed baseline-to-observed order.":"The visible claim wording does not contain every value in its typed assertion.",`${claim.assertion.metric}: ${typedValues.join(" / ")}`,`${metricAppears?"metric present":"metric missing"}; ${claimNumbers.length?claimNumbers.join(" / "):"no numeric values"}`),
    check("claim-unit-binding","Visible unit binding",unitBindingPasses?"pass":"fail",unitBindingPasses?"The visible wording preserves the typed unit.":"The typed unit does not appear in the visible claim wording.",claim.assertion.unit,unitBindingPasses?"unit present":"unit missing"),
    check("evidence-relevance","Linked evidence relevance",coveragePasses?(relevancePasses?"pass":"fail"):"blocked",coveragePasses?(relevancePasses?"Every linked source contains a typed fact for the claim metric.":`Unrelated linked evidence: ${sharedEvidence.filter((item)=>!relevantEvidenceIds.includes(item.id)).map((item)=>item.id).join(", ")}.`):"Resolve and share every linked source before checking relevance.","every linked source matches the claim metric",`${relevantEvidenceIds.length}/${sharedEvidence.length}`)
  ];
  const facts=sharedEvidence.flatMap((evidence)=>evidence.facts.map((fact)=>({fact,evidenceId:evidence.id,passage:evidence.passage})));
  const matches=facts.filter(({fact})=>normalized(fact.metric)===normalized(claim.assertion.metric));
  const match=matches[0];
  if(!match){
    checks.push(check("metric-match","Metric identity",coveragePasses?"fail":"blocked",coveragePasses?"No structured source fact matches the claim metric.":"Link and share evidence before matching the metric.",claim.assertion.metric));
    checks.push(check("source-binding","Exact excerpt binding","blocked","A matching source fact is required first."),check("source-conflict","Cross-source consistency","blocked","A matching source fact is required first."),check("fact-shape","Source fact shape","blocked","A matching source fact is required first."),check("unit-match","Unit consistency","blocked","A matching source fact is required first."),check("window-match","Scope consistency","blocked","A matching source fact is required first."),check("value-check","Quantitative value","blocked","A matching source fact is required first."));
  }else{
    checks.push(check("metric-match","Metric identity","pass",`Matched a typed fact from ${match.evidenceId}.`,claim.assertion.metric,match.fact.metric));
    const bindingPasses=matches.every(({fact,passage})=>{
      const values=numericValues(fact.sourceExcerpt);
      const requiredValues=fact.kind==="range"?[fact.baseline,fact.observed]:[fact.value];
      return passage.includes(fact.sourceExcerpt)&&requiredValues.every((required)=>values.some((value)=>closeEnough(value,required)));
    });
    checks.push(check("source-binding","Exact excerpt binding",bindingPasses?"pass":"fail",bindingPasses?"Every typed fact is bound to an exact source excerpt containing its quantitative values.":"A typed fact is missing from its cited passage or its values are not present in the exact excerpt."));
    const firstFact=match.fact;
    const sourcesAgree=matches.every(({fact})=>fact.kind===firstFact.kind&&normalized(fact.unit)===normalized(firstFact.unit)&&normalized(fact.sourceWindow)===normalized(firstFact.sourceWindow)&&(fact.kind==="range"&&firstFact.kind==="range"?closeEnough(fact.baseline,firstFact.baseline)&&closeEnough(fact.observed,firstFact.observed):fact.kind==="scalar"&&firstFact.kind==="scalar"&&closeEnough(fact.value,firstFact.value)));
    checks.push(check("source-conflict","Cross-source consistency",sourcesAgree?"pass":"fail",sourcesAgree?`${matches.length} matching source fact${matches.length===1?" has":"s have"} no quantitative conflict.`:"Linked sources disagree on values, units, evaluation scope, or fact shape.","matching linked sources agree",sourcesAgree?"agree":"conflict"));
    const expectedFactKind=claim.assertion.kind==="scalar"?"scalar":"range";
    const shapePasses=match.fact.kind===expectedFactKind;
    checks.push(check("fact-shape","Source fact shape",shapePasses?"pass":"fail",shapePasses?"The source fact shape matches the claim assertion.":`${claim.assertion.kind} assertions require a ${expectedFactKind} source fact.`,expectedFactKind,match.fact.kind));
    const unitPasses=normalized(match.fact.unit)===normalized(claim.assertion.unit);
    checks.push(check("unit-match","Unit consistency",unitPasses?"pass":"fail",unitPasses?"Claim and source use the same unit.":"Claim and source units differ.",match.fact.unit,claim.assertion.unit));
    const windowPasses=normalized(match.fact.sourceWindow)===normalized(claim.assertion.sourceWindow);
    checks.push(check("window-match","Scope consistency",windowPasses?"pass":"fail",windowPasses?"The claim preserves the source evaluation window.":"The claim scope does not match the source window.",match.fact.sourceWindow,claim.assertion.sourceWindow));
    if(!shapePasses){
      checks.push(check("value-check","Quantitative value","blocked","The assertion and source fact shapes must match before values can be compared."));
    }else if(claim.assertion.kind==="percentage_change"&&match.fact.kind==="range"){
      const actualPercent=rounded(((match.fact.observed-match.fact.baseline)/match.fact.baseline)*100);
      const arithmeticPasses=Number.isFinite(actualPercent)&&closeEnough(actualPercent,claim.assertion.claimedPercent);
      checks.push(check("value-check","Percentage arithmetic",arithmeticPasses?"pass":"fail",arithmeticPasses?`(${match.fact.observed} − ${match.fact.baseline}) / ${match.fact.baseline} resolves to the claimed change.`:`The source values resolve to ${actualPercent}%, not ${claim.assertion.claimedPercent}%.`,actualPercent,claim.assertion.claimedPercent));
    }else if(claim.assertion.kind==="before_after"&&match.fact.kind==="range"){
      const baselinePasses=closeEnough(match.fact.baseline,claim.assertion.baseline);
      const observedPasses=closeEnough(match.fact.observed,claim.assertion.observed);
      checks.push(check("value-check","Before/after values",baselinePasses&&observedPasses?"pass":"fail",baselinePasses&&observedPasses?"Both quantitative values match the source fact.":"At least one quantitative value differs from the source fact.",`${match.fact.baseline} → ${match.fact.observed}`,`${claim.assertion.baseline} → ${claim.assertion.observed}`));
    }else if(claim.assertion.kind==="scalar"&&match.fact.kind==="scalar"){
      const valuePasses=closeEnough(match.fact.value,claim.assertion.claimedValue);
      checks.push(check("value-check","Scalar value",valuePasses?"pass":"fail",valuePasses?"The claimed scalar value matches the source fact.":"The claimed scalar value differs from the source fact.",match.fact.value,claim.assertion.claimedValue));
    }
  }
  const status:CheckStatus=checks.some((item)=>item.status==="fail")?"fail":checks.some((item)=>item.status==="blocked")?"blocked":"pass";
  return {schemaVersion:1,claimId,workspaceRevision:workspace.revision,status,sourceEvidenceIds:sharedEvidence.map((item)=>item.id),checks};
}

export function getReleaseCheck(workspace:Workspace):ReleaseCheck {
  const blockers:string[]=[];
  if(workspace.claims.length===0) return {ready:false,stage:0,blockers:["workspace: at least one claim is required"]};
  const manifests=workspace.claims.map((claim)=>compileClaimVerification(workspace,claim.id));
  const linkedCount=workspace.claims.filter((claim)=>claim.linkedEvidenceIds.length>0).length;
  workspace.claims.forEach((claim,index)=>{
    const manifest=manifests[index];
    if(claim.linkedEvidenceIds.length===0) blockers.push(`${claim.id}: no evidence linked`);
    if(manifest.status!=="pass"){const firstFailure=manifest.checks.find((item)=>item.status!=="pass");blockers.push(`${claim.id}: compiler ${manifest.status}${firstFailure?` — ${firstFailure.label}`:""}`)}
    if(claim.state==="unreviewed") blockers.push(`${claim.id}: agent review pending`);
    if(claim.state==="unsupported") blockers.push(`${claim.id}: unsupported`);
    if(claim.state==="contradicted") blockers.push(`${claim.id}: contradiction unresolved`);
    if(claim.state==="supported"&&claim.humanDecision!=="approved") blockers.push(`${claim.id}: human confirmation required`);
  });
  const pending=workspace.proposals.some((proposal)=>proposal.state==="pending");
  if(pending) blockers.push("revision proposal awaiting human decision");
  const allReviewed=workspace.claims.every((claim)=>claim.state!=="unreviewed");
  const allCompiled=manifests.every((manifest)=>manifest.status==="pass");
  const allResolved=workspace.claims.every((claim)=>claim.state==="supported"&&claim.humanDecision==="approved")&&allCompiled;
  const stage:ReleaseCheck["stage"]=allResolved&&!pending?3:allReviewed&&allCompiled?2:linkedCount===workspace.claims.length?1:0;
  return {ready:stage===3&&blockers.length===0,stage,blockers};
}

export function linkEvidence(workspace:Workspace,claimId:string,evidenceId:string,rationale:string):Workspace {
  const source=workspace.evidence.find((item)=>item.id===evidenceId);
  if(!source) throw new Error("Evidence not found.");
  if(!source.sharedWithAgent) throw new Error("Evidence is not shared with site tools. A human must share it first.");
  if(!workspace.claims.some((claim)=>claim.id===claimId)) throw new Error("Claim not found.");
  if(rationale.trim().length<10||rationale.length>300) throw new Error("Rationale must be 10–300 characters.");
  return {...workspace,revision:nextRevision(workspace),claims:workspace.claims.map((claim)=>claim.id===claimId?{...claim,linkedEvidenceIds:[...new Set([...claim.linkedEvidenceIds,evidenceId])],state:"unreviewed",rationale:rationale.trim(),humanDecision:"pending"}:claim),activity:[...workspace.activity,event(workspace,"agent",`Linked ${evidenceId} to ${claimId}; prior review decisions were invalidated.`)]};
}

export function unlinkEvidence(workspace:Workspace,claimId:string,evidenceId:string,rationale:string):Workspace {
  const claim=workspace.claims.find((item)=>item.id===claimId);
  if(!claim) throw new Error("Claim not found.");
  if(!workspace.evidence.some((item)=>item.id===evidenceId)) throw new Error("Evidence not found.");
  if(!claim.linkedEvidenceIds.includes(evidenceId)) throw new Error("Evidence is not linked to this claim.");
  if(rationale.trim().length<10||rationale.length>300) throw new Error("Rationale must be 10–300 characters.");
  return {...workspace,revision:nextRevision(workspace),claims:workspace.claims.map((item)=>item.id===claimId?{...item,linkedEvidenceIds:item.linkedEvidenceIds.filter((id)=>id!==evidenceId),state:"unreviewed",rationale:rationale.trim(),humanDecision:"pending"}:item),activity:[...workspace.activity,event(workspace,"agent",`Unlinked ${evidenceId} from ${claimId}; prior review decisions were invalidated.`)]};
}

export function flagClaim(workspace:Workspace,claimId:string,state:Exclude<ClaimState,"unreviewed">,rationale:string):Workspace {
  if(!workspace.claims.some((claim)=>claim.id===claimId)) throw new Error("Claim not found.");
  if(!(["supported","contradicted","unsupported"] as string[]).includes(state)) throw new Error("Invalid claim review state.");
  if(rationale.trim().length<10||rationale.length>300) throw new Error("Rationale must be 10–300 characters.");
  const manifest=compileClaimVerification(workspace,claimId);
  if(state==="supported"&&manifest.status!=="pass") throw new Error("A claim cannot be marked supported until every deterministic check passes.");
  return {...workspace,revision:nextRevision(workspace),claims:workspace.claims.map((claim)=>claim.id===claimId?{...claim,state,rationale:rationale.trim(),humanDecision:"pending"}:claim),activity:[...workspace.activity,event(workspace,"agent",`Marked ${claimId} ${state} after compiler review.`)]};
}

export function proposeRevision(workspace:Workspace,claimId:string,proposedText:string,reason:string,proposedAssertion?:QuantitativeAssertion):Workspace {
  const claim=workspace.claims.find((item)=>item.id===claimId);
  if(!claim) throw new Error("Claim not found.");
  if(workspace.proposals.some((item)=>item.claimId===claimId&&item.state==="pending")) throw new Error("A revision proposal is already pending for this claim.");
  if(proposedText.trim().length<10||proposedText.length>500) throw new Error("Proposed text must be 10–500 characters.");
  if(reason.trim().length<10||reason.length>300) throw new Error("Reason must be 10–300 characters.");
  const revision=nextRevision(workspace);
  const proposal:RevisionProposal={id:`proposal-${revision}`,claimId,proposedText:proposedText.trim(),...(proposedAssertion?{proposedAssertion}:{}),reason:reason.trim(),state:"pending",createdAt:new Date().toISOString(),basedOnRevision:revision,claimTextAtCreation:claim.text};
  return {...workspace,revision,proposals:[...workspace.proposals,proposal],activity:[...workspace.activity,event(workspace,"agent",`Staged a revision for ${claimId}.`)]};
}

export function decideProposal(workspace:Workspace,proposalId:string,decision:"accepted"|"rejected"):Workspace {
  const proposal=workspace.proposals.find((item)=>item.id===proposalId&&item.state==="pending");
  if(!proposal) throw new Error("Pending proposal not found.");
  if(!(["accepted","rejected"] as string[]).includes(decision)) throw new Error("Invalid proposal decision.");
  const currentClaim=workspace.claims.find((claim)=>claim.id===proposal.claimId);
  const staleProposal=workspace.revision!==proposal.basedOnRevision||currentClaim?.text!==proposal.claimTextAtCreation;
  if(decision==="accepted"&&staleProposal) throw new Error(`Proposal is stale. It was based on revision ${proposal.basedOnRevision}; current revision is ${workspace.revision}. Dismiss it and stage a new proposal.`);
  const next:Workspace={...workspace,revision:nextRevision(workspace),claims:workspace.claims.map((claim)=>claim.id===proposal.claimId?{...claim,text:decision==="accepted"?proposal.proposedText:claim.text,assertion:decision==="accepted"&&proposal.proposedAssertion?proposal.proposedAssertion:claim.assertion,rationale:decision==="accepted"?null:claim.rationale,humanDecision:decision==="accepted"?"approved":"rejected"}:claim),proposals:workspace.proposals.map((item)=>item.id===proposalId?{...item,state:decision}:item),activity:[...workspace.activity,event(workspace,"human",`${decision==="accepted"?"Approved":staleProposal?"Dismissed stale":"Rejected"} ${proposalId}.`)]};
  if(decision==="accepted"){
    const manifest=compileClaimVerification(next,proposal.claimId);
    next.claims=next.claims.map((claim)=>claim.id===proposal.claimId?{...claim,state:manifest.status==="pass"?"supported":"contradicted"}:claim);
  }
  return next;
}

export function confirmClaim(workspace:Workspace,claimId:string):Workspace {
  const claim=workspace.claims.find((item)=>item.id===claimId);
  if(!claim) throw new Error("Claim not found.");
  if(claim.state!=="supported") throw new Error("Only a compiler-supported claim can be confirmed.");
  if(compileClaimVerification(workspace,claimId).status!=="pass") throw new Error("Every deterministic check must pass before human confirmation.");
  if(claim.humanDecision==="approved") return workspace;
  return {...workspace,revision:nextRevision(workspace),claims:workspace.claims.map((item)=>item.id===claimId?{...item,humanDecision:"approved"}:item),activity:[...workspace.activity,event(workspace,"human",`Confirmed compiled finding for ${claimId}.`)]};
}

export function toggleEvidenceSharing(workspace:Workspace,evidenceId:string):Workspace {
  const target=workspace.evidence.find((item)=>item.id===evidenceId);
  if(!target) throw new Error("Evidence not found.");
  return {...workspace,revision:nextRevision(workspace),evidence:workspace.evidence.map((item)=>item.id===evidenceId?{...item,sharedWithAgent:!item.sharedWithAgent}:item),claims:workspace.claims.map((claim)=>claim.linkedEvidenceIds.includes(evidenceId)?{...claim,state:"unreviewed",rationale:null,humanDecision:"pending"}:claim),activity:[...workspace.activity,event(workspace,"human",`${target.sharedWithAgent?"Made private":"Shared"} ${evidenceId}; prior linked-claim decisions were invalidated.`)]};
}

export function replaceWorkspace(current:Workspace,incoming:Workspace,reason:string):Workspace{
  const revision=Math.max(current.revision,incoming.revision)+1;
  if(!Number.isSafeInteger(revision)) throw new Error("Workspace revision limit reached; export the workspace before replacing it.");
  return {...incoming,revision,claims:incoming.claims.map((claim)=>({...claim,state:"unreviewed",rationale:null,humanDecision:"pending"})),proposals:incoming.proposals.map((proposal)=>proposal.state==="pending"?{...proposal,state:"rejected"}:proposal),activity:[...incoming.activity,{id:`event-${revision}-${incoming.activity.length+1}`,actor:"human",message:reason,revision}]};
}

export function runExampleAgentReview(workspace:Workspace):Workspace {
  const growth=workspace.claims.find((claim)=>claim.id==="claim-growth");
  if(growth?.state==="unreviewed"){
    let next=linkEvidence(workspace,"claim-growth","evidence-pilot-note","Compile the stated percentage against the linked source values.");
    const manifest=compileClaimVerification(next,"claim-growth");
    const failure=manifest.checks.find((item)=>item.status==="fail");
    next=flagClaim(next,"claim-growth","contradicted",failure?.detail??"The quantitative compiler found a source mismatch.");
    return proposeRevision(next,"claim-growth","The pilot increased weekly completed reviews by 20% across four weekly cycles.","Use the computed change and preserve the source evaluation window.",{kind:"percentage_change",metric:"weekly completed reviews",claimedPercent:20,unit:"reviews/week",sourceWindow:"four weekly cycles"});
  }
  const timing=workspace.claims.find((claim)=>claim.id==="claim-time");
  if(timing?.state==="unreviewed"){
    let next=linkEvidence(workspace,"claim-time","evidence-timing","Compile both timing values against the linked timing table.");
    const manifest=compileClaimVerification(next,"claim-time");
    if(manifest.status!=="pass") throw new Error("The timing claim did not pass deterministic verification.");
    next=flagClaim(next,"claim-time","supported","Metric, unit, scope, baseline, and observed value all pass deterministic checks.");
    return next;
  }
  throw new Error("Every example claim has already been reviewed.");
}

export function createVerificationPacket(workspace:Workspace){return {schemaVersion:1 as const,compilerVersion:"0.2.0" as const,workspaceRevision:workspace.revision,release:getReleaseCheck(workspace),manifests:workspace.claims.map((claim)=>compileClaimVerification(workspace,claim.id))}}

export function createExportPacket(workspace:Workspace):string {
  const verification=createVerificationPacket(workspace);
  if(!verification.release.ready) throw new Error(`Export is locked: ${verification.release.blockers[0]??"release requirements are incomplete"}.`);
  const claims=workspace.claims.map((claim,index)=>{
    const sources=claim.linkedEvidenceIds.map((id)=>workspace.evidence.find((item)=>item.id===id)).filter((item):item is Evidence=>Boolean(item));
    const manifest=verification.manifests.find((item)=>item.claimId===claim.id)!;
    return [`## ${index+1}. ${claim.text}`,`Review state: ${claim.state}`,`Human decision: ${claim.humanDecision}`,`Compiler status: ${manifest.status} (${manifest.checks.filter((item)=>item.status==="pass").length}/${manifest.checks.length} checks passed)`,`Rationale: ${claim.rationale??"None recorded"}`,...sources.flatMap((source)=>[`Source: ${source.title} — ${source.sourceLabel}`,`> ${source.passage}`])].join("\n\n");
  }).join("\n\n---\n\n");
  return ["# Verified report packet",`Workspace revision: ${workspace.revision}`,"Release check: passed","Generated locally. Evidence selection and the final release decision remain the reviewer's responsibility.",claims,"## Machine-readable verification manifest","```json",JSON.stringify(verification,null,2),"```","## Revision activity",...workspace.activity.map((item)=>`- r${item.revision} · ${item.actor}: ${item.message}`)].join("\n\n");
}
