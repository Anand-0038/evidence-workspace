import {describe,expect,it} from "vitest";
import {exampleWorkspace} from "./domain";
import {CORRUPT_STORAGE_KEY,loadWorkspace,parseWorkspaceJson,saveWorkspace,WORKSPACE_STORAGE_KEY} from "./storage";
import {createNewReview,type ClaimDraft,type EvidenceDraft} from "./review-builder";

class MemoryStorage{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null}
  setItem(key:string,value:string){this.values.set(key,value)}
}

describe("local workspace persistence",()=>{
  it("loads the safe example when no saved state exists",()=>{const result=loadWorkspace(new MemoryStorage());expect(result).toMatchObject({source:"default",warning:null});expect(result.workspace).toEqual(exampleWorkspace);expect(result.workspace).not.toBe(exampleWorkspace)});
  it("round-trips a validated workspace",()=>{const storage=new MemoryStorage();const workspace=structuredClone(exampleWorkspace);workspace.revision=7;expect(saveWorkspace(storage,workspace)).toBeNull();expect(loadWorkspace(storage)).toMatchObject({source:"storage",workspace:{revision:7}})});
  it("quarantines corrupt JSON and fails back to the labeled example",()=>{const storage=new MemoryStorage();storage.setItem(WORKSPACE_STORAGE_KEY,"{broken");const result=loadWorkspace(storage);expect(result.source).toBe("recovered");expect(result.warning).toContain("invalid");expect(storage.getItem(CORRUPT_STORAGE_KEY)).toBe("{broken");expect(result.workspace).toEqual(exampleWorkspace)});
  it("rejects structurally malformed saved state",()=>{const storage=new MemoryStorage();storage.setItem(WORKSPACE_STORAGE_KEY,JSON.stringify({...exampleWorkspace,claims:[{id:"bad"}]}));expect(loadWorkspace(storage)).toMatchObject({source:"recovered",workspace:{revision:1}})});
  it("recovers instead of loading a claimless workspace into the claim UI",()=>{const storage=new MemoryStorage();storage.setItem(WORKSPACE_STORAGE_KEY,JSON.stringify({...exampleWorkspace,claims:[]}));const result=loadWorkspace(storage);expect(result.source).toBe("recovered");expect(result.workspace.claims[0].id).toBe("claim-growth")});
  it("validates an explicit workspace JSON import",()=>{expect(parseWorkspaceJson(JSON.stringify(exampleWorkspace))).toMatchObject({ok:true,workspace:{schemaVersion:1}});expect(parseWorkspaceJson("[]")).toEqual({ok:false,error:"Workspace does not match schema version 1."})});
  it("normalizes legacy range facts without changing the storage schema",()=>{const legacy=structuredClone(exampleWorkspace) as unknown as {evidence:Array<{facts:Array<Record<string,unknown>>}>};legacy.evidence.forEach((item)=>item.facts.forEach((fact)=>delete fact.kind));const parsed=parseWorkspaceJson(JSON.stringify(legacy));expect(parsed.ok).toBe(true);if(parsed.ok)expect(parsed.workspace.evidence[0].facts[0]).toMatchObject({kind:"range",baseline:50,observed:60})});
  it("round-trips scalar workspaces",()=>{const claim:ClaimDraft={text:"The launch processed 72 review packets.",kind:"scalar",metric:"review packets",unit:"packets",sourceWindow:"launch week",claimedPercent:"",baseline:"",observed:"",claimedValue:"72"};const evidence:EvidenceDraft={title:"Launch note",sourceLabel:"Internal note",passage:"The launch processed 72 review packets during launch week.",sourceExcerpt:"The launch processed 72 review packets during launch week.",kind:"primary",sharedWithAgent:false,factKind:"scalar",metric:"review packets",unit:"packets",sourceWindow:"launch week",baseline:"",observed:"",value:"72"};const created=createNewReview({title:"Launch report",claim,evidence});expect(created.ok).toBe(true);if(created.ok)expect(parseWorkspaceJson(JSON.stringify(created.value))).toMatchObject({ok:true,workspace:{claims:[{assertion:{kind:"scalar",claimedValue:72}}],evidence:[{facts:[{kind:"scalar",value:72}]}]}})});
});
