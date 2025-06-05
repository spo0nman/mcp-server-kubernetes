import { execSync } from "child_process";
import {
  ExplainResourceParams,
  ListApiResourcesParams,
} from "../models/kubectl-models.js";

export const explainResourceSchema = {
  name: "explain_resource",
  description: "Get documentation for a Kubernetes resource or field",
  inputSchema: {
    type: "object",
    properties: {
      resource: {
        type: "string",
        description:
          "Resource name or field path (e.g. 'pods' or 'pods.spec.containers')",
      },
      apiVersion: {
        type: "string",
        description: "API version to use (e.g. 'apps/v1')",
      },
      recursive: {
        type: "boolean",
        description: "Print the fields of fields recursively",
        default: false,
      },
      output: {
        type: "string",
        description: "Output format (plaintext or plaintext-openapiv2)",
        enum: ["plaintext", "plaintext-openapiv2"],
        default: "plaintext",
      },
    },
    required: ["resource"],
  },
};

export const listApiResourcesSchema = {
  name: "list_api_resources",
  description: "List the API resources available in the cluster",
  inputSchema: {
    type: "object",
    properties: {
      apiGroup: {
        type: "string",
        description: "API group to filter by",
      },
      namespaced: {
        type: "boolean",
        description: "If true, only show namespaced resources",
      },
      verbs: {
        type: "array",
        items: {
          type: "string",
        },
        description: "List of verbs to filter by",
      },
      output: {
        type: "string",
        description: "Output format (wide, name, or no-headers)",
        enum: ["wide", "name", "no-headers"],
        default: "wide",
      },
    },
  },
};

const executeKubectlCommand = (command: string): string => {
  process.stderr.write(`🔍 [KUBECTL EXEC] executeKubectlCommand() started at ${new Date().toISOString()}\n`);
  process.stderr.write(`🔍 [KUBECTL EXEC] Command to execute: ${command}\n`);
  
  // Debug environment variables
  process.stderr.write(`🔍 [KUBECTL EXEC] Environment variables check:\n`);
  process.stderr.write(`  - KUBECONFIG: ${process.env.KUBECONFIG || 'NOT SET'}\n`);
  process.stderr.write(`  - KUBECONFIG_YAML: ${process.env.KUBECONFIG_YAML ? `SET (length: ${process.env.KUBECONFIG_YAML.length})` : 'NOT SET'}\n`);
  process.stderr.write(`  - HOME: ${process.env.HOME || 'NOT SET'}\n`);
  process.stderr.write(`  - USER: ${process.env.USER || 'NOT SET'}\n`);
  
  // Check if KUBECONFIG file exists (if set)
  if (process.env.KUBECONFIG) {
    try {
      const fs = require('fs');
      const kubeconfigExists = fs.existsSync(process.env.KUBECONFIG);
      const stats = kubeconfigExists ? fs.statSync(process.env.KUBECONFIG) : null;
      process.stderr.write(`🔍 [KUBECTL EXEC] KUBECONFIG file check:\n`);
      process.stderr.write(`  - File path: ${process.env.KUBECONFIG}\n`);
      process.stderr.write(`  - File exists: ${kubeconfigExists}\n`);
      if (stats) {
        process.stderr.write(`  - File size: ${stats.size} bytes\n`);
        process.stderr.write(`  - File mode: ${stats.mode.toString(8)}\n`);
        process.stderr.write(`  - Last modified: ${stats.mtime.toISOString()}\n`);
      }
    } catch (fileCheckError) {
      process.stderr.write(`⚠️ [KUBECTL EXEC] Could not check KUBECONFIG file: ${fileCheckError}\n`);
    }
  }
  
  try {
    process.stderr.write(`🔍 [KUBECTL EXEC] About to execute kubectl command...\n`);
    
    const result = execSync(command, { 
      encoding: "utf8", 
      env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
      stdio: ['pipe', 'pipe', 'pipe'] // Capture stderr separately
    });
    
    process.stderr.write(`🔍 [KUBECTL EXEC] ✅ kubectl command executed successfully\n`);
    process.stderr.write(`🔍 [KUBECTL EXEC] Result length: ${result.length} characters\n`);
    process.stderr.write(`🔍 [KUBECTL EXEC] Result preview (first 200 chars): ${result.substring(0, 200)}...\n`);
    
    return result;
  } catch (error: any) {
    process.stderr.write(`❌ [KUBECTL EXEC] CRITICAL ERROR in kubectl execution:\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Command: ${command}\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Error message: ${error.message}\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Error status: ${error.status}\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Error signal: ${error.signal}\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Error stdout: ${error.stdout || 'none'}\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Error stderr: ${error.stderr || 'none'}\n`);
    process.stderr.write(`❌ [KUBECTL EXEC] Full error object: ${JSON.stringify(error, null, 2)}\n`);
    
    throw new Error(`Kubectl command failed: ${error.message}`);
  }
};

export async function explainResource(
  params: ExplainResourceParams
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    let command = "kubectl explain";

    if (params.apiVersion) {
      command += ` --api-version=${params.apiVersion}`;
    }

    if (params.recursive) {
      command += " --recursive";
    }

    if (params.output) {
      command += ` --output=${params.output}`;
    }

    command += ` ${params.resource}`;

    const result = executeKubectlCommand(command);

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error: any) {
    throw new Error(`Failed to explain resource: ${error.message}`);
  }
}

export async function listApiResources(
  params: ListApiResourcesParams
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    let command = "kubectl api-resources";

    if (params.apiGroup) {
      command += ` --api-group=${params.apiGroup}`;
    }

    if (params.namespaced !== undefined) {
      command += ` --namespaced=${params.namespaced}`;
    }

    if (params.verbs && params.verbs.length > 0) {
      command += ` --verbs=${params.verbs.join(",")}`;
    }

    if (params.output) {
      command += ` -o ${params.output}`;
    }

    const result = executeKubectlCommand(command);

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error: any) {
    throw new Error(`Failed to list API resources: ${error.message}`);
  }
}
