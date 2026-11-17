import type { VesperModule } from '../types/chat';

export const BUILT_IN_MODULES: VesperModule[] = [
  {
    id: 'builtin_audit',
    name: 'Secure Code Audit',
    command: '/audit',
    description: 'Spot vulnerabilities, OWASP risks, and suggest hardened code fixes.',
    instruction:
      'Perform a defensive secure code review. Identify potential vulnerabilities (such as injection, XSS, broken auth, SSRF, or unsafe deserialization), explain the risk clearly, and provide patched, secure code.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: 'builtin_cli',
    name: 'CLI Command Guide',
    command: '/cli',
    description: 'Generate safe Linux, networking, and diagnostic CLI commands with flag breakdowns.',
    instruction:
      'Provide accurate, safe CLI commands for Linux, macOS, Docker, or authorized network diagnostics. Break down each flag concisely and note any permissions or safety considerations.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: 'builtin_threat',
    name: 'Threat Intel & Defense',
    command: '/threat',
    description: 'Analyze threat concepts, attack vectors, and defensive hardening ethically.',
    instruction:
      'Provide ethical threat intelligence and defensive security analysis. Cover how an attack class works conceptually, detection indicators, and concrete mitigation/hardening steps. Strictly refuse offensive exploitation requests.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: 'builtin_debug',
    name: 'IT & Dev Troubleshooter',
    command: '/debug',
    description: 'Diagnose stack traces, server logs, and configuration errors step by step.',
    instruction:
      'Act as a rapid IT and software troubleshooting partner. Identify the most likely root causes from logs or symptoms, suggest verification steps, and provide clean fixes.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

export function normalizeModuleCommand(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return cleaned ? `/${cleaned}` : '/custom';
}
