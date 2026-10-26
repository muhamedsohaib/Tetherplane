import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";

const argv = process.argv.slice(2);
for(const flag of ["--tetherd", "--allow", "--state-dir"]){
 if(!argv.includes(flag) || !argv[argv.indexOf(flag)+1] || !existsSync(argv[argv.indexOf(flag)+1])){
   console.error("SYNTHETIC_LAUNCHER_ARGS_MISSING " + flag);
   process.exit(31);
 }
}
const server = new Server({name:"tetherplane-windows-stdio-fixture",version:"0.1.0"}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
 tools:["batch","browser","desktop","device","files","process"].map(name=>({
  name,description:"disposable test-only tool",inputSchema:{type:"object",properties:{}}
 }))
}));
await server.connect(new StdioServerTransport());
