import type {HumanDecision,VerificationManifest} from "./domain";

export interface TraceNode { id:string; label:string; status:"PASS"|"FAIL"|"WAIT"; detail:string; expected?:string|number; actual?:string|number }
export interface TraceModel { compiler:string; human:string; relation:"MATCH"|"MISMATCH"|"VALUE COMPARISON UNAVAILABLE"; sourceValue:string; claimValue:string; resultDetail:string; nodes:TraceNode[]; groups:TraceNode[]; announcement:string }

const humanLabel:Record<HumanDecision,string>={pending:"AWAITING HUMAN",approved:"APPROVED",rejected:"REJECTED"};
const displayValue=(value:string|number|undefined,percentage:boolean)=>value===undefined?"—":`${value}${percentage?"%":""}`;

export function createTraceModel(manifest:VerificationManifest,humanDecision:HumanDecision):TraceModel{
  const nodes=manifest.checks.map((item)=>({...item,status:item.status==="pass"?"PASS" as const:item.status==="fail"?"FAIL" as const:"WAIT" as const}));
  const groupDefinitions=[
    {id:"claim",label:"Claim binding",checks:["claim-binding","claim-unit-binding"]},
    {id:"evidence",label:"Evidence binding",checks:["source-coverage","evidence-relevance","source-binding"]},
    {id:"consistency",label:"Consistency",checks:["metric-match","source-conflict","fact-shape","unit-match","window-match"]},
    {id:"value",label:"Quantitative value",checks:["value-check"]}
  ];
  const groups=groupDefinitions.map((group)=>{
    const members=nodes.filter((node)=>group.checks.includes(node.id));
    const status=members.some((node)=>node.status==="FAIL")?"FAIL" as const:members.some((node)=>node.status==="WAIT")?"WAIT" as const:"PASS" as const;
    return {id:group.id,label:group.label,status,detail:members.find((node)=>node.status!=="PASS")?.detail??"All related deterministic checks pass."};
  });
  const value=manifest.checks.find((item)=>item.id==="value-check");
  const comparable=value?.status!=="blocked"&&value?.expected!==undefined&&value.actual!==undefined;
  const relation=comparable?(value.status==="pass"?"MATCH":"MISMATCH"):"VALUE COMPARISON UNAVAILABLE";
  const firstNonPass=manifest.checks.find((item)=>item.status!=="pass");
  const human=humanLabel[humanDecision];
  const announcement=manifest.status==="pass"?`Verification updated. All deterministic checks pass. Human decision ${humanDecision}.`:`Verification updated. Compiler ${manifest.status} at ${firstNonPass?.label??"an unresolved check"}. Human decision ${humanDecision}.`;
  return {compiler:`COMPILER ${manifest.status.toUpperCase()}`,human,relation,sourceValue:displayValue(value?.expected,value?.label==="Percentage arithmetic"),claimValue:displayValue(value?.actual,value?.label==="Percentage arithmetic"),resultDetail:firstNonPass?.detail??"Every deterministic check passes.",nodes,groups,announcement};
}

export function VerificationTrace({manifest,humanDecision}:{manifest:VerificationManifest;humanDecision:HumanDecision}){
  const model=createTraceModel(manifest,humanDecision);
  return <section className={`verification-trace trace-${manifest.status}`} aria-labelledby="verification-trace-title">
    <header><div><p className="kicker">Claim check</p><h2 id="verification-trace-title">Why this claim {manifest.status==="pass"?"passes":"needs attention"}</h2></div><span className={`compiler-verdict verdict-${manifest.status}`}>{model.compiler}</span></header>
    <p className="compiler-boundary">Checks internal consistency against human-shared typed evidence—not objective truth.</p>
    <p className="visually-hidden" aria-live="polite">{model.announcement}</p>
    <div className="trace-layout">
      <div className="trace-path"><p className="trace-label">Check path</p><ol>{model.groups.map((node)=><li key={node.id} className={`trace-node node-${node.status.toLowerCase()}`}><span className="trace-spine" aria-hidden="true"/><span className="trace-symbol" aria-hidden="true">{node.status==="PASS"?"✓":node.status==="FAIL"?"×":"—"}</span><span className="trace-status">{node.status}</span><strong>{node.label}</strong></li>)}</ol></div>
      <aside className="trace-result" aria-label="Current verification result"><p className="trace-label">Current result</p><dl><div><dt>Source result</dt><dd>{model.sourceValue}</dd></div><div><dt>Claim value</dt><dd>{model.claimValue}</dd></div><div><dt>Relation</dt><dd className={`relation-${model.relation.startsWith("MATCH")?"match":model.relation==="MISMATCH"?"mismatch":"unavailable"}`}>{model.relation}</dd></div><div><dt>Human decision</dt><dd>{model.human}</dd></div></dl><p>{model.resultDetail}</p></aside>
    </div>
    <details className="trace-details"><summary>Show all {manifest.checks.length} checks</summary><ol>{manifest.checks.map((item)=><li key={item.id} className={`check-${item.status}`}><span className="check-mark">{item.status==="pass"?"PASS":item.status==="fail"?"FAIL":"WAIT"}</span><div><strong>{item.label}</strong><p>{item.detail}</p>{(item.expected!==undefined||item.actual!==undefined)&&<code>source {String(item.expected??"—")} · claim {String(item.actual??"—")}</code>}</div></li>)}</ol></details>
  </section>;
}
