/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Cloud CLI tool definitions (aws-cli, gcloud, gsutil, azure-cli)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Cloud CLI tool definitions (aws-cli, gcloud, gsutil, azure-cli) — part of
 * the seed catalog aligned with the any-bot/Dockerfile baseline image.
 */
export const cloudTools: CreateToolInput[] = [
  {
    name: 'aws-cli',
    displayName: 'AWS CLI',
    type: ToolType.CLI,
    category: 'cloud',
    version: '2.15.0',
    description: 'Official command-line interface for Amazon Web Services',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'aws --version',
    },
    skills: ['aws', 'cloud', 's3', 'ec2', 'lambda', 'iam'],
    selectorFragment: 'AWS resource management including S3, EC2, Lambda, and IAM',
    routingTags: ['aws', 'cloud', 's3', 'ec2', 'lambda'],
    authGroup: 'aws',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'AWS service (s3, ec2, lambda, etc.)' },
        command: { type: 'string', description: 'AWS CLI command' },
        region: { type: 'string', description: 'AWS region' },
      },
      required: ['service', 'command'],
    },
    usageInstructions: 'Use AWS CLI to manage AWS cloud resources. Ensure AWS credentials are configured.',
    examples: [
      { command: 'aws s3 ls', description: 'List S3 buckets' },
      { command: 'aws ec2 describe-instances', description: 'List EC2 instances' },
    ],
    requiresApproval: true,
    timeoutMs: 60000,
    tags: ['aws', 'cloud', 'infrastructure'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'gcloud',
    displayName: 'Google Cloud CLI',
    type: ToolType.CLI,
    category: 'cloud',
    version: '460.0.0',
    description: 'Command-line interface for Google Cloud Platform',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'gcloud version',
    },
    skills: ['gcp', 'cloud', 'gke', 'compute', 'storage'],
    selectorFragment: 'Google Cloud Platform resource management including GKE, Compute Engine, and Cloud Storage',
    routingTags: ['gcp', 'google-cloud', 'gke', 'cloud'],
    authGroup: 'gcp',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'GCP service (compute, storage, container, etc.)' },
        command: { type: 'string', description: 'gcloud command' },
        project: { type: 'string', description: 'GCP project ID' },
      },
      required: ['service', 'command'],
    },
    usageInstructions: 'Use gcloud to manage Google Cloud resources. Authenticate with gcloud auth login first.',
    examples: [
      { command: 'gcloud compute instances list', description: 'List compute instances' },
      { command: 'gcloud container clusters list', description: 'List GKE clusters' },
    ],
    requiresApproval: true,
    timeoutMs: 60000,
    tags: ['gcp', 'cloud', 'infrastructure'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'gsutil',
    displayName: 'Google Cloud Storage Utility',
    type: ToolType.CLI,
    category: 'cloud',
    version: '5.27',
    description: 'Command-line tool for Google Cloud Storage operations',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'gsutil version',
      dependencies: ['gcloud'],
    },
    skills: ['gcp', 'cloud-storage', 'bucket-management', 'object-storage'],
    selectorFragment: 'Google Cloud Storage bucket and object management',
    routingTags: ['gsutil', 'gcs', 'gcp', 'storage', 'buckets'],
    authGroup: 'gcp',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'gsutil command to execute' },
        bucket: { type: 'string', description: 'GCS bucket name' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use gsutil to manage Google Cloud Storage buckets and objects.',
    examples: [
      { command: 'gsutil ls', description: 'List all buckets' },
      { command: 'gsutil cp file.txt gs://my-bucket/', description: 'Copy file to bucket' },
    ],
    requiresApproval: true,
    timeoutMs: 60000,
    tags: ['gcp', 'cloud', 'storage'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'azure-cli',
    displayName: 'Azure CLI',
    type: ToolType.CLI,
    category: 'cloud',
    version: '2.56.0',
    description: 'Command-line interface for Microsoft Azure',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'az --version',
    },
    skills: ['azure', 'cloud', 'aks', 'vm', 'storage'],
    selectorFragment: 'Microsoft Azure resource management including AKS, VMs, and Storage',
    routingTags: ['azure', 'cloud', 'aks', 'microsoft'],
    authGroup: 'azure',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Azure service (vm, aks, storage, etc.)' },
        command: { type: 'string', description: 'az command' },
        resourceGroup: { type: 'string', description: 'Resource group name' },
      },
      required: ['service', 'command'],
    },
    usageInstructions: 'Use Azure CLI to manage Azure cloud resources. Login with az login first.',
    examples: [
      { command: 'az vm list', description: 'List virtual machines' },
      { command: 'az aks list', description: 'List AKS clusters' },
    ],
    requiresApproval: true,
    timeoutMs: 60000,
    tags: ['azure', 'cloud', 'infrastructure'],
    enabled: true,
    registeredBy: 'system',
  },
];
