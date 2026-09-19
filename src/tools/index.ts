import { tool } from "ai";
import { readSchema, readTool } from "./read.js";
import { writeSchema, writeTool } from "./write.js";
import { editSchema, editTool } from "./edit.js";
import { bashSchema, bashTool } from "./bash.js";
import { globSchema, globTool } from "./glob.js";
import { grepSchema, grepTool } from "./grep.js";

export const tools = {
  read: tool({ description: "Read file or directory", parameters: readSchema, execute: readTool }),
  write: tool({ description: "Write file (creates dirs)", parameters: writeSchema, execute: writeTool }),
  edit: tool({ description: "Exact string replacement in file", parameters: editSchema, execute: editTool }),
  bash: tool({ description: "Execute shell command (PowerShell/WSL)", parameters: bashSchema, execute: bashTool }),
  glob: tool({ description: "Find files by glob pattern", parameters: globSchema, execute: globTool }),
  grep: tool({ description: "Search file contents by regex", parameters: grepSchema, execute: grepTool }),
};
