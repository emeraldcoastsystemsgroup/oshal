/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Kubernetes tool definitions (kubectl, helm, argocd)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Kubernetes tool definitions (kubectl, helm, argocd) — part of the
 * seed catalog aligned with the any-bot/Dockerfile baseline image.
 */
export const kubernetesTools: CreateToolInput[] = [
  {
    name: 'kubectl',
    displayName: 'Kubernetes CLI',
    type: ToolType.CLI,
    category: 'devops',
    version: '1.28.0',
    description: 'Command-line tool for controlling Kubernetes clusters',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'kubectl version --client',
    },
    skills: ['kubernetes', 'cluster-management', 'pod-management', 'deployment', 'service-management'],
    selectorFragment: 'Kubernetes cluster administration and resource management',
    routingTags: ['k8s', 'kubernetes', 'pods', 'deployments', 'services', 'namespaces'],
    authGroup: 'kubernetes',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'kubectl command to execute' },
        namespace: { type: 'string', description: 'Kubernetes namespace' },
      },
      required: ['command'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        exitCode: { type: 'number' },
      },
    },
    usageInstructions: 'Use kubectl to manage Kubernetes resources. Always specify namespace when applicable.',
    examples: [
      { command: 'kubectl get pods -n default', description: 'List pods in default namespace' },
      { command: 'kubectl describe deployment my-app', description: 'Describe a deployment' },
    ],
    requiresApproval: true,
    timeoutMs: 60000,
    tags: ['kubernetes', 'devops', 'containers'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'helm',
    displayName: 'Helm Package Manager',
    type: ToolType.CLI,
    category: 'devops',
    version: '3.13.0',
    description: 'The package manager for Kubernetes',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'helm version',
      dependencies: ['kubectl'],
    },
    skills: ['kubernetes', 'helm', 'package-management', 'chart-deployment'],
    selectorFragment: 'Helm chart management and Kubernetes application deployment',
    routingTags: ['helm', 'charts', 'k8s', 'packages'],
    authGroup: 'kubernetes',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Helm command to execute' },
        release: { type: 'string', description: 'Helm release name' },
        chart: { type: 'string', description: 'Chart name' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Helm to deploy and manage Kubernetes applications via charts.',
    examples: [
      { command: 'helm list', description: 'List all helm releases' },
      { command: 'helm install myapp stable/nginx', description: 'Install a chart' },
    ],
    requiresApproval: true,
    timeoutMs: 120000,
    tags: ['kubernetes', 'devops', 'package-manager'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'argocd',
    displayName: 'Argo CD CLI',
    type: ToolType.CLI,
    category: 'devops',
    version: '2.9.0',
    description: 'Declarative GitOps continuous delivery tool for Kubernetes',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'argocd version --client',
      dependencies: ['kubectl'],
    },
    skills: ['kubernetes', 'gitops', 'continuous-delivery', 'argocd'],
    selectorFragment: 'ArgoCD GitOps application deployment and synchronization',
    routingTags: ['argocd', 'gitops', 'cd', 'k8s'],
    authGroup: 'kubernetes',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'ArgoCD command to execute' },
        application: { type: 'string', description: 'Application name' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use ArgoCD CLI to manage GitOps application deployments.',
    examples: [
      { command: 'argocd app list', description: 'List all applications' },
      { command: 'argocd app sync myapp', description: 'Sync an application' },
    ],
    requiresApproval: true,
    timeoutMs: 90000,
    tags: ['kubernetes', 'gitops', 'devops'],
    enabled: true,
    registeredBy: 'system',
  },
];
