import type { VesperModule } from '../types/chat';

export const BUILT_IN_MODULES: VesperModule[] = [
  {
    id: 'builtin_write',
    name: 'Writing & Polish',
    command: '/write',
    description: 'Draft, rewrite, summarize, or adjust tone for emails, essays, and messages.',
    instruction:
      'Help the user write, edit, summarize, or polish text clearly and naturally. Match the tone they ask for (casual, professional, concise, or detailed) without adding unnecessary filler.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: 'builtin_explain',
    name: 'Clear Explainer',
    command: '/explain',
    description: 'Break down any topic simply with clear analogies and key takeaways.',
    instruction:
      'Explain concepts in plain, easy-to-follow language using relatable everyday examples and clear bullet takeaways before diving into deeper detail if requested.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: 'builtin_code',
    name: 'Code & Debug Helper',
    command: '/code',
    description: 'Write clean code, fix errors, and explain solutions in any language.',
    instruction:
      'Help write clean, maintainable code, diagnose errors or stack traces, and explain fixes step by step in whatever programming language or framework the user is working with.',
    enabled: true,
    builtIn: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: 'builtin_vision',
    name: 'Image & Doc Analyzer',
    command: '/vision',
    description: 'Extract text (OCR), explain diagrams, read charts, and analyze uploaded photos.',
    instruction:
      'Carefully inspect any attached images, screenshots, charts, or documents. Extract text accurately when asked, summarize visual details clearly, and answer questions directly based on what is shown.',
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
