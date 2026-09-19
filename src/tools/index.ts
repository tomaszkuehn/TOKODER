import { tool } from "ai";
import { readSchema, readTool } from "./read.js";
import { writeSchema, writeTool } from "./write.js";
import { editSchema, editTool } from "./edit.js";
import { bashSchema, bashTool } from "./bash.js";
import { globSchema, globTool } from "./glob.js";
import { grepSchema, grepTool } from "./grep.js";

export const tools = {
  read: tool({ description: "Read file or directory", inputSchema: readSchema, execute: readTool as any }),
  write: tool({ description: "Write file (creates dirs)", inputSchema: writeSchema, execute: writeTool as any }),
  edit: tool({ description: "Exact string replacement in file", inputSchema: editSchema, execute: editTool as any }),
  bash: tool({ description: "Execute shell command (PowerShell/WSL)", inputSchema: bashSchema, execute: bashTool as any }),
  glob: tool({ description: "Find files by glob pattern", inputSchema: globSchema, execute: globTool as any }),
  grep: tool({ description: "Search file contents by regex", inputSchema: grepSchema, execute: grepTool as any }),
};
