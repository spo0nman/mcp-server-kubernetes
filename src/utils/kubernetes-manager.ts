import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as k8s from "@kubernetes/client-node";

import { ResourceTracker, PortForwardTracker, WatchTracker } from "../types.js";

export class KubernetesManager {
  private resources: ResourceTracker[] = [];
  private portForwards: PortForwardTracker[] = [];
  private watches: WatchTracker[] = [];
  private kc: k8s.KubeConfig;
  private k8sApi: k8s.CoreV1Api;
  private k8sAppsApi: k8s.AppsV1Api;
  private k8sBatchApi: k8s.BatchV1Api;

  constructor() {
    this.kc = new k8s.KubeConfig();
    
    // 🔍 DEBUG: Log environment state at startup
    process.stderr.write(`🔍 [KUBERNETES MANAGER] Constructor started at ${new Date().toISOString()}\n`);
    process.stderr.write(`🔍 [KUBERNETES MANAGER] Environment check:\n`);
    process.stderr.write(`  - KUBECONFIG_YAML: ${process.env.KUBECONFIG_YAML ? `SET (length: ${process.env.KUBECONFIG_YAML.length})` : 'NOT SET'}\n`);
    process.stderr.write(`  - KUBECONFIG_JSON: ${process.env.KUBECONFIG_JSON ? `SET (length: ${process.env.KUBECONFIG_JSON.length})` : 'NOT SET'}\n`);
    process.stderr.write(`  - K8S_SERVER: ${process.env.K8S_SERVER ? 'SET' : 'NOT SET'}\n`);
    process.stderr.write(`  - K8S_TOKEN: ${process.env.K8S_TOKEN ? `SET (length: ${process.env.K8S_TOKEN.length})` : 'NOT SET'}\n`);
    process.stderr.write(`  - KUBECONFIG_PATH: ${process.env.KUBECONFIG_PATH ? 'SET' : 'NOT SET'}\n`);
    process.stderr.write(`  - KUBECONFIG: ${process.env.KUBECONFIG ? 'SET' : 'NOT SET'}\n`);
    
    // Check each configuration method in priority order
    if (this.isRunningInCluster()) {
      // Priority 1: In-cluster configuration (existing)
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Using Priority 1: In-cluster configuration\n`);
      this.kc.loadFromCluster();
    } else if (this.hasEnvKubeconfigYaml()) {
      // Priority 2: Full kubeconfig as YAML string
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Using Priority 2: KUBECONFIG_YAML environment variable\n`);
      process.stderr.write(`🔍 [KUBERNETES MANAGER] KUBECONFIG_YAML preview (first 200 chars): ${process.env.KUBECONFIG_YAML!.substring(0, 200)}...\n`);
      try {
        process.stderr.write(`🔍 [KUBERNETES MANAGER] About to call loadEnvKubeconfigYaml()\n`);
        this.loadEnvKubeconfigYaml();
        process.stderr.write(`🔍 [KUBERNETES MANAGER] ✅ loadEnvKubeconfigYaml() completed successfully\n`);
        
        process.stderr.write(`🔍 [KUBERNETES MANAGER] About to call createTempKubeconfigFromYaml()\n`);
        this.createTempKubeconfigFromYaml(process.env.KUBECONFIG_YAML!);
        process.stderr.write(`🔍 [KUBERNETES MANAGER] ✅ createTempKubeconfigFromYaml() completed successfully\n`);
      } catch (error) {
        process.stderr.write(`❌ [KUBERNETES MANAGER] CRITICAL ERROR in KUBECONFIG_YAML processing: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
        process.stderr.write(`❌ [KUBERNETES MANAGER] Error stack: ${error instanceof Error ? error.stack : 'No stack available'}\n`);
        throw new Error(`Failed to parse KUBECONFIG_YAML: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (this.hasEnvKubeconfigJson()) {
      // Priority 3: Full kubeconfig as JSON string
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Using Priority 3: KUBECONFIG_JSON environment variable\n`);
      try {
        this.loadEnvKubeconfigJson();
        // Create temp kubeconfig file for kubectl commands from JSON
        const yamlConfig = this.kc.exportConfig();
        this.createTempKubeconfigFromYaml(yamlConfig);
      } catch (error) {
        process.stderr.write(`❌ [KUBERNETES MANAGER] ERROR in KUBECONFIG_JSON processing: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
        throw new Error(`Failed to parse KUBECONFIG_JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (this.hasEnvMinimalKubeconfig()) {
      // Priority 4: Minimal config with individual environment variables
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Using Priority 4: Minimal kubeconfig (K8S_SERVER + K8S_TOKEN)\n`);
      try {
        this.loadEnvMinimalKubeconfig();
        // Create temp kubeconfig file for kubectl commands from minimal config
        const yamlConfig = this.kc.exportConfig();
        this.createTempKubeconfigFromYaml(yamlConfig);
      } catch (error) {
        process.stderr.write(`❌ [KUBERNETES MANAGER] ERROR in minimal kubeconfig processing: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
        throw new Error(`Failed to create kubeconfig from K8S_SERVER and K8S_TOKEN: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (this.hasEnvKubeconfigPath()) {
      // Priority 5: Custom kubeconfig file path
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Using Priority 5: KUBECONFIG_PATH environment variable\n`);
      try {
        this.loadEnvKubeconfigPath();
        // Set KUBECONFIG environment variable to the custom path for kubectl commands
        process.env.KUBECONFIG = process.env.KUBECONFIG_PATH;
        process.stderr.write(`🔍 [KUBERNETES MANAGER] Set KUBECONFIG to: ${process.env.KUBECONFIG}\n`);
      } catch (error) {
        process.stderr.write(`❌ [KUBERNETES MANAGER] ERROR in KUBECONFIG_PATH processing: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
        throw new Error(`Failed to load kubeconfig from KUBECONFIG_PATH: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else {
      // Priority 6: Default file-based configuration (existing fallback)
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Using Priority 6: Default file-based configuration\n`);
      this.kc.loadFromDefault();
    }

    // Apply context override if specified
    if (process.env.K8S_CONTEXT) {
      process.stderr.write(`🔍 [KUBERNETES MANAGER] Applying context override: ${process.env.K8S_CONTEXT}\n`);
      try {
        this.setCurrentContext(process.env.K8S_CONTEXT);
        process.stderr.write(`🔍 [KUBERNETES MANAGER] ✅ Context set successfully to: ${process.env.K8S_CONTEXT}\n`);
      } catch (error) {
        process.stderr.write(`⚠️ [KUBERNETES MANAGER] Warning: Could not set context to ${process.env.K8S_CONTEXT}: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
        console.warn(`Warning: Could not set context to ${process.env.K8S_CONTEXT}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
    
    // 🔍 DEBUG: Final environment state after configuration
    process.stderr.write(`🔍 [KUBERNETES MANAGER] Final state after configuration:\n`);
    process.stderr.write(`  - KUBECONFIG (final): ${process.env.KUBECONFIG || 'NOT SET'}\n`);
    process.stderr.write(`  - Current context: ${this.kc.getCurrentContext() || 'NOT SET'}\n`);
    
    // Initialize API clients
    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.k8sAppsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.k8sBatchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    
    process.stderr.write(`🔍 [KUBERNETES MANAGER] ✅ Constructor completed successfully at ${new Date().toISOString()}\n`);
  }

  /**
   * A very simple test to check if the application is running inside a Kubernetes cluster
   */
  private isRunningInCluster(): boolean {
    const serviceAccountPath =
      "/var/run/secrets/kubernetes.io/serviceaccount/token";
    try {
      return fs.existsSync(serviceAccountPath);
    } catch {
      return false;
    }
  }

  /**
   * Check if KUBECONFIG_YAML environment variable is available
   */
  private hasEnvKubeconfigYaml(): boolean {
    const hasYaml = !!(process.env.KUBECONFIG_YAML && process.env.KUBECONFIG_YAML.trim());
    process.stderr.write(`🔍 [HAS YAML] hasEnvKubeconfigYaml() check:\n`);
    process.stderr.write(`  - process.env.KUBECONFIG_YAML exists: ${!!process.env.KUBECONFIG_YAML}\n`);
    process.stderr.write(`  - process.env.KUBECONFIG_YAML length: ${process.env.KUBECONFIG_YAML ? process.env.KUBECONFIG_YAML.length : 0}\n`);
    process.stderr.write(`  - process.env.KUBECONFIG_YAML.trim() length: ${process.env.KUBECONFIG_YAML ? process.env.KUBECONFIG_YAML.trim().length : 0}\n`);
    process.stderr.write(`  - Final result: ${hasYaml}\n`);
    return hasYaml;
  }

  /**
   * Check if KUBECONFIG_JSON environment variable is available
   */
  private hasEnvKubeconfigJson(): boolean {
    return !!(process.env.KUBECONFIG_JSON && process.env.KUBECONFIG_JSON.trim());
  }

  /**
   * Check if minimal K8S_SERVER and K8S_TOKEN environment variables are available
   */
  private hasEnvMinimalKubeconfig(): boolean {
    return !!(
      process.env.K8S_SERVER &&
      process.env.K8S_SERVER.trim() &&
      process.env.K8S_TOKEN &&
      process.env.K8S_TOKEN.trim()
    );
  }

  /**
   * Load kubeconfig from KUBECONFIG_PATH environment variable (file path)
   */
  private loadEnvKubeconfigPath(): void {
    this.kc.loadFromFile(process.env.KUBECONFIG_PATH!);
  }

  /**
   * Load kubeconfig from KUBECONFIG_YAML environment variable (YAML format)
   */
  private loadEnvKubeconfigYaml(): void {
    process.stderr.write(`🔍 [LOAD YAML] loadEnvKubeconfigYaml() started at ${new Date().toISOString()}\n`);
    
    if (!process.env.KUBECONFIG_YAML) {
      const errorMsg = 'KUBECONFIG_YAML environment variable is not set';
      process.stderr.write(`❌ [LOAD YAML] ERROR: ${errorMsg}\n`);
      throw new Error(errorMsg);
    }
    
    process.stderr.write(`🔍 [LOAD YAML] KUBECONFIG_YAML found with length: ${process.env.KUBECONFIG_YAML.length}\n`);
    process.stderr.write(`🔍 [LOAD YAML] KUBECONFIG_YAML preview (first 300 chars):\n${process.env.KUBECONFIG_YAML.substring(0, 300)}...\n`);
    
    try {
      // Load the config into the JavaScript client
      process.stderr.write(`🔍 [LOAD YAML] About to call this.kc.loadFromString()...\n`);
      this.kc.loadFromString(process.env.KUBECONFIG_YAML);
      process.stderr.write(`🔍 [LOAD YAML] ✅ this.kc.loadFromString() completed successfully\n`);
      
      // Verify the config was loaded
      try {
        const currentContext = this.kc.getCurrentContext();
        const contexts = this.kc.getContexts();
        process.stderr.write(`🔍 [LOAD YAML] Config verification:\n`);
        process.stderr.write(`  - Current context: ${currentContext || 'NOT SET'}\n`);
        process.stderr.write(`  - Available contexts: ${contexts.map(c => c.name).join(', ')}\n`);
        process.stderr.write(`  - Number of contexts: ${contexts.length}\n`);
      } catch (verifyError) {
        process.stderr.write(`⚠️ [LOAD YAML] Warning: Could not verify loaded config: ${verifyError}\n`);
      }
      
      process.stderr.write(`🔍 [LOAD YAML] ✅ loadEnvKubeconfigYaml() completed successfully at ${new Date().toISOString()}\n`);
    } catch (error) {
      process.stderr.write(`❌ [LOAD YAML] CRITICAL ERROR in loadEnvKubeconfigYaml(): ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      process.stderr.write(`❌ [LOAD YAML] Error stack: ${error instanceof Error ? error.stack : 'No stack available'}\n`);
      throw error;
    }
  }

  /**
   * Load kubeconfig from KUBECONFIG_JSON environment variable (JSON format)
   */
  private loadEnvKubeconfigJson(): void {
    const configObj = JSON.parse(process.env.KUBECONFIG_JSON!);
    this.kc.loadFromOptions(configObj);
  }

  /**
   * Load kubeconfig from minimal K8S_SERVER and K8S_TOKEN environment variables
   */
  private loadEnvMinimalKubeconfig(): void {
    if (!process.env.K8S_SERVER || !process.env.K8S_TOKEN) {
      throw new Error('K8S_SERVER and K8S_TOKEN environment variables are required');
    }

    const cluster = {
      name: 'env-cluster',
      server: process.env.K8S_SERVER,
      skipTLSVerify: process.env.K8S_SKIP_TLS_VERIFY === 'true'
    };
    
    const user = {
      name: 'env-user',
      token: process.env.K8S_TOKEN
    };
    
    const context = {
      name: 'env-context',
      user: user.name,
      cluster: cluster.name
    };
    
    const kubeconfigContent = {
      clusters: [cluster],
      users: [user],
      contexts: [context],
      currentContext: context.name
    };
    
    this.kc.loadFromOptions(kubeconfigContent);
  }

  /**
   * Check if KUBECONFIG_PATH environment variable is available
   */
  private hasEnvKubeconfigPath(): boolean {
    return !!(process.env.KUBECONFIG_PATH && process.env.KUBECONFIG_PATH.trim());
  }

  /**
   * Set the current context to the desired context name.
   *
   * @param contextName
   */
  public setCurrentContext(contextName: string) {
    // Get all available contexts
    const contexts = this.kc.getContexts();
    const contextNames = contexts.map((context) => context.name);

    // Check if the requested context exists
    if (!contextNames.includes(contextName)) {
      throw new Error(
        `Context '${contextName}' not found. Available contexts: ${contextNames.join(
          ", "
        )}`
      );
    }
    // Set the current context
    this.kc.setCurrentContext(contextName);
    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.k8sAppsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.k8sBatchApi = this.kc.makeApiClient(k8s.BatchV1Api);
  }

  async cleanup() {
    // Stop watches
    for (const watch of this.watches) {
      watch.abort.abort();
    }

    // Delete tracked resources in reverse order
    for (const resource of [...this.resources].reverse()) {
      try {
        await this.deleteResource(
          resource.kind,
          resource.name,
          resource.namespace
        );
      } catch (error) {
        process.stderr.write(
          `Failed to delete ${resource.kind} ${resource.name}: ${error}\n`
        );
      }
    }
  }

  trackResource(kind: string, name: string, namespace: string) {
    this.resources.push({ kind, name, namespace, createdAt: new Date() });
  }

  async deleteResource(kind: string, name: string, namespace: string) {
    switch (kind.toLowerCase()) {
      case "pod":
        await this.k8sApi.deleteNamespacedPod(name, namespace);
        break;
      case "deployment":
        await this.k8sAppsApi.deleteNamespacedDeployment(name, namespace);
        break;
      case "service":
        await this.k8sApi.deleteNamespacedService(name, namespace);
        break;
      case "cronjob":
        await this.k8sBatchApi.deleteNamespacedCronJob(name, namespace);
        break;
    }
    this.resources = this.resources.filter(
      (r) => !(r.kind === kind && r.name === name && r.namespace === namespace)
    );
  }

  trackPortForward(pf: PortForwardTracker) {
    this.portForwards.push(pf);
  }

  getPortForward(id: string) {
    return this.portForwards.find((p) => p.id === id);
  }

  removePortForward(id: string) {
    this.portForwards = this.portForwards.filter((p) => p.id !== id);
  }

  trackWatch(watch: WatchTracker) {
    this.watches.push(watch);
  }

  getKubeConfig() {
    return this.kc;
  }

  getCoreApi() {
    return this.k8sApi;
  }

  getAppsApi() {
    return this.k8sAppsApi;
  }

  getBatchApi() {
    return this.k8sBatchApi;
  }

  /**
   * Get the default namespace for operations
   * Uses K8S_NAMESPACE environment variable if set, otherwise defaults to "default"
   */
  getDefaultNamespace(): string {
    return process.env.K8S_NAMESPACE || 'default';
  }

  /**
   * Create temporary kubeconfig file from YAML content for kubectl commands
   * @param kubeconfigYaml YAML content of the kubeconfig
   */
  private createTempKubeconfigFromYaml(kubeconfigYaml: string): void {
    process.stderr.write(`🔍 [TEMP KUBECONFIG] createTempKubeconfigFromYaml() started at ${new Date().toISOString()}\n`);
    process.stderr.write(`🔍 [TEMP KUBECONFIG] Input validation:\n`);
    process.stderr.write(`  - kubeconfigYaml is truthy: ${!!kubeconfigYaml}\n`);
    process.stderr.write(`  - kubeconfigYaml type: ${typeof kubeconfigYaml}\n`);
    process.stderr.write(`  - kubeconfigYaml length: ${kubeconfigYaml ? kubeconfigYaml.length : 'N/A'}\n`);
    
    try {
      if (!kubeconfigYaml || typeof kubeconfigYaml !== 'string') {
        const errorMsg = `Invalid kubeconfigYaml: ${typeof kubeconfigYaml}`;
        process.stderr.write(`❌ [TEMP KUBECONFIG] ERROR: ${errorMsg}\n`);
        throw new Error(errorMsg);
      }

      const tempDir = os.tmpdir();
      process.stderr.write(`🔍 [TEMP KUBECONFIG] Using temp directory: ${tempDir}\n`);
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const randomString = Math.random().toString(36).substring(2);
      const tempKubeconfigPath = path.join(tempDir, `kubeconfig-${timestamp}-${randomString}`);
      
      process.stderr.write(`🔍 [TEMP KUBECONFIG] Generated temp file path: ${tempKubeconfigPath}\n`);
      
      // Check if temp directory is writable
      try {
        const testFile = path.join(tempDir, `test-write-${randomString}`);
        fs.writeFileSync(testFile, 'test', { mode: 0o600 });
        fs.unlinkSync(testFile);
        process.stderr.write(`🔍 [TEMP KUBECONFIG] ✅ Temp directory is writable\n`);
      } catch (writeTestError) {
        process.stderr.write(`❌ [TEMP KUBECONFIG] ERROR: Temp directory is not writable: ${writeTestError}\n`);
        throw new Error(`Temp directory not writable: ${writeTestError}`);
      }
      
      // Write temporary kubeconfig file
      process.stderr.write(`🔍 [TEMP KUBECONFIG] About to write kubeconfig to temp file...\n`);
      fs.writeFileSync(tempKubeconfigPath, kubeconfigYaml, { mode: 0o600, encoding: 'utf8' });
      process.stderr.write(`🔍 [TEMP KUBECONFIG] ✅ Successfully wrote kubeconfig to: ${tempKubeconfigPath}\n`);
      
      // Verify the file was created and has content
      try {
        const stats = fs.statSync(tempKubeconfigPath);
        process.stderr.write(`🔍 [TEMP KUBECONFIG] File verification:\n`);
        process.stderr.write(`  - File exists: ${fs.existsSync(tempKubeconfigPath)}\n`);
        process.stderr.write(`  - File size: ${stats.size} bytes\n`);
        process.stderr.write(`  - File mode: ${stats.mode.toString(8)}\n`);
        
        // Read back a preview to ensure it was written correctly
        const writtenContent = fs.readFileSync(tempKubeconfigPath, 'utf8');
        process.stderr.write(`  - Content length: ${writtenContent.length} chars\n`);
        process.stderr.write(`  - Content preview (first 100 chars): ${writtenContent.substring(0, 100)}...\n`);
      } catch (verifyError) {
        process.stderr.write(`❌ [TEMP KUBECONFIG] ERROR: Could not verify written file: ${verifyError}\n`);
        throw new Error(`File verification failed: ${verifyError}`);
      }
      
      // Set KUBECONFIG environment variable for kubectl commands
      process.stderr.write(`🔍 [TEMP KUBECONFIG] Setting KUBECONFIG environment variable...\n`);
      process.stderr.write(`🔍 [TEMP KUBECONFIG] Before: KUBECONFIG = ${process.env.KUBECONFIG || 'NOT SET'}\n`);
      
      process.env.KUBECONFIG = tempKubeconfigPath;
      
      process.stderr.write(`🔍 [TEMP KUBECONFIG] After: KUBECONFIG = ${process.env.KUBECONFIG}\n`);
      process.stderr.write(`🔍 [TEMP KUBECONFIG] ✅ KUBECONFIG environment variable set successfully\n`);
      
      // Function to clean up the temporary file
      const cleanupTempFile = () => {
        try {
          if (fs.existsSync(tempKubeconfigPath)) {
            fs.unlinkSync(tempKubeconfigPath);
            process.stderr.write(`🔍 [TEMP KUBECONFIG] ✅ Cleaned up temp file: ${tempKubeconfigPath}\n`);
          }
        } catch (cleanupError) {
          process.stderr.write(`⚠️ [TEMP KUBECONFIG] Warning: Could not clean up temp file: ${cleanupError}\n`);
          // Ignore cleanup errors
        }
      };
      
      // Schedule cleanup of temporary file when process exits
      process.on('exit', cleanupTempFile);
      
      // Also clean up on SIGINT and SIGTERM (common in Docker containers)
      ['SIGINT', 'SIGTERM'].forEach(signal => {
        process.on(signal, () => {
          process.stderr.write(`🔍 [TEMP KUBECONFIG] Received ${signal}, cleaning up...\n`);
          cleanupTempFile();
          process.exit(0);
        });
      });
      
      // Additional cleanup for Docker container lifecycle
      ['SIGUSR1', 'SIGUSR2'].forEach(signal => {
        process.on(signal, cleanupTempFile);
      });
      
      process.stderr.write(`🔍 [TEMP KUBECONFIG] ✅ createTempKubeconfigFromYaml() completed successfully at ${new Date().toISOString()}\n`);
      
    } catch (error) {
      process.stderr.write(`❌ [TEMP KUBECONFIG] CRITICAL ERROR in createTempKubeconfigFromYaml(): ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      process.stderr.write(`❌ [TEMP KUBECONFIG] Error stack: ${error instanceof Error ? error.stack : 'No stack available'}\n`);
      // Continue without temporary file - kubectl commands may fail but JavaScript client will work
      throw error;
    }
  }
}
