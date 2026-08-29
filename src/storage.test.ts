import {describe,expect,it} from "vitest";
import {exampleWorkspace} from "./domain";
import {CORRUPT_STORAGE_KEY,loadWorkspace,parseWorkspaceJson,saveWorkspace,WORKSPACE_STORAGE_KEY} from "./storage";

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
});
