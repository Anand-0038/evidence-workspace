import {afterEach,describe,expect,it,vi} from "vitest";
import {confirmClaim,decideProposal,exampleWorkspace,runExampleAgentReview,toggleEvidenceSharing,type Workspace} from "./domain";
import {registerSiteTools} from "./webmcp";

describe("WebMCP contracts",()=>{
  afterEach(()=>vi.restoreAllMocks());
  it("registers narrow top-level tools and rejects stale writes",async()=>{
    const tools:WebMCP.ModelContextTool[]=[];
    const modelContext={registerTool:vi.fn(async(tool:WebMCP.ModelContextTool,options?:{signal?:AbortSignal})=>{tools.push(tool);options?.signal?.addEventListener("abort",()=>{const index=tools.indexOf(tool);if(index>=0)tools.splice(index,1)},{once:true})})};
    vi.stubGlobal("document",{modelContext});
    let workspace:Workspace=structuredClone(exampleWorkspace);
    const controller=await registerSiteTools(()=>workspace,(next)=>{workspace=next});
    expect(tools.map((tool)=>tool.name)).toEqual(expect.arrayContaining(["review_get_summary","review_get_claim_context","review_run_checks","review_link_evidence","review_flag_claim","review_propose_revision","review_get_release_check"]));
    expect(tools.map((tool)=>tool.name)).not.toContain("review_export_packet");
    expect(tools.every((tool)=>(tool.inputSchema as {additionalProperties?:boolean}).additionalProperties===false)).toBe(true);
    const link=tools.find((tool)=>tool.name==="review_link_evidence")!;
    const response=await link.execute({expectedRevision:99,claimId:"claim-growth",evidenceId:"evidence-pilot-note",rationale:"The source contains a different value."},{signal:new AbortController().signal}) as {ok:boolean;workspaceRevision:number};
    expect(response).toMatchObject({ok:false,workspaceRevision:1});
    expect(workspace.revision).toBe(1);
    const checks=tools.find((tool)=>tool.name==="review_run_checks")!;
    const beforeRevision=workspace.revision;
    const verification=await checks.execute({claimId:"claim-growth"},{signal:new AbortController().signal}) as {ok:boolean;verification:{status:string}};
    expect(verification).toMatchObject({ok:true,verification:{status:"fail"}});
    expect(workspace.revision).toBe(beforeRevision);
    const aborted=new AbortController();aborted.abort();
    const canceled=await link.execute({expectedRevision:1,claimId:"claim-growth",evidenceId:"evidence-pilot-note",rationale:"The source contains a different value."},{signal:aborted.signal}) as {ok:boolean;message:string};
    expect(canceled).toMatchObject({ok:false,message:"Tool call canceled before mutation."});
    expect(workspace.revision).toBe(1);
    workspace=runExampleAgentReview(workspace);workspace=decideProposal(workspace,workspace.proposals.at(-1)!.id,"accepted");workspace=toggleEvidenceSharing(workspace,"evidence-timing");workspace=runExampleAgentReview(workspace);workspace=confirmClaim(workspace,"claim-time");
    await controller?.reconcileExport();
    expect(tools.map((tool)=>tool.name)).toContain("review_export_packet");
    workspace=toggleEvidenceSharing(workspace,"evidence-timing");
    await controller?.reconcileExport();
    expect(tools.map((tool)=>tool.name)).not.toContain("review_export_packet");
    controller?.abort();
    expect(tools).toHaveLength(0);
  });
});
