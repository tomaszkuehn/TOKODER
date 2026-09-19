import { tool } from "ai";
import { readSchema, readTool } from "./read.js";
import { writeSchema, writeTool } from "./write.js";
import { editSchema, editTool } from "./edit.js";
import { bashSchema, bashTool } from "./bash.js";
import { globSchema, globTool } from "./glob.js";
import { grepSchema, grepTool } from "./grep.js";

export const agentTools = {
  read: tool({ description: "Read file or directory", inputSchema: readSchema }),
  write: tool({ description: "Write file (creates dirs)", inputSchema: writeSchema }),
  edit: tool({ description: "Exact string replacement in file", inputSchema: editSchema }),
  bash: tool({ description: "Execute shell command (PowerShell/WSL)", inputSchema: bashSchema }),
  glob: tool({ description: "Find files by glob pattern", inputSchema: globSchema }),
  grep: tool({ description: "Search file contents by regex", inputSchema: grepSchema }),
};

export const agentToolNames = Object.keys(agentTools);

export type ToolCtx = { signal?: AbortSignal };
export const executors: Record<string, (args: any, ctx?: ToolCtx) => Promise<any>> = {
  read: readTool as any,
  write: writeTool as any,
  edit: editTool as any,
  bash: bashTool as any,
  glob: globTool as any,
  grep: grepTool as any,
};
