import React, { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { VesperModule } from '../types/chat';
import { normalizeModuleCommand } from '../lib/modules';

interface ModulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  builtInModules: VesperModule[];
  customModules: VesperModule[];
  onToggleModule: (mod: VesperModule) => void;
  onCreateCustomModule: (mod: {
    name: string;
    command: string;
    description: string;
    instruction: string;
  }) => Promise<void>;
  onDeleteCustomModule: (moduleId: string) => Promise<void>;
  onUseCommand: (command: string) => void;
}

export function ModulesModal({
  isOpen,
  onClose,
  builtInModules,
  customModules,
  onToggleModule,
  onCreateCustomModule,
  onDeleteCustomModule,
  onUseCommand,
}: ModulesModalProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('/');
  const [description, setDescription] = useState('');
  const [instruction, setInstruction] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    const trimmedInst = instruction.trim();
    if (!trimmedName) {
      setFormError('Module name is required.');
      return;
    }
    if (!trimmedInst) {
      setFormError('Module instruction is required.');
      return;
    }
    const normalizedCmd = normalizeModuleCommand(command || trimmedName);
    const allCmds = [...builtInModules, ...customModules].map((m) => m.command);
    if (allCmds.includes(normalizedCmd)) {
      setFormError(`Command ${normalizedCmd} already exists.`);
      return;
    }

    setSaving(true);
    try {
      await onCreateCustomModule({
        name: trimmedName,
        command: normalizedCmd,
        description: description.trim() || `Custom function triggered via ${normalizedCmd}`,
        instruction: trimmedInst,
      });
      setName('');
      setCommand('/');
      setDescription('');
      setInstruction('');
      setShowAddForm(false);
    } catch {
      setFormError('Could not save module.');
    } finally {
      setSaving(false);
    }
  };

  const renderModuleCard = (mod: VesperModule, isCustom: boolean) => (
    <div
      key={mod.id}
      className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-[#1e2333] dark:border-t-white/10 dark:bg-[#0f111a]/80"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-medium text-violet-600 dark:text-[#4cd7f6]">
            {mod.command}
          </span>
          <span className="text-sm font-semibold text-slate-900 dark:text-[#f8fafc]">
            {mod.name}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-[#94a3b8]">
          {mod.description}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              onUseCommand(mod.command);
              onClose();
            }}
            className="font-mono text-[11px] font-medium text-violet-600 hover:text-violet-700 dark:text-[#d0bcff] dark:hover:text-white"
          >
            Use {mod.command}
          </button>
          {isCustom && (
            <button
              type="button"
              onClick={() => void onDeleteCustomModule(mod.id)}
              aria-label={`Delete ${mod.name}`}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-red-600 dark:text-[#64748b] dark:hover:text-[#ffb4ab]"
            >
              <Trash2 className="h-3 w-3" />
              <span>Remove</span>
            </button>
          )}
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={mod.enabled}
        aria-label={`Toggle ${mod.name}`}
        onClick={() => onToggleModule(mod)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] ${
          mod.enabled ? 'bg-[#8b5cf6]' : 'bg-slate-300 dark:bg-[#1e2333]'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            mod.enabled ? 'translate-x-4.5' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090a0f]/75 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Vesper AI Modules"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-slate-200 bg-white dark:border-[#1e2333] dark:border-t-white/10 dark:bg-[#181b26]/92 dark:shadow-[0_0_32px_-8px_rgba(139,92,246,0.25)] dark:backdrop-blur-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-[#1e2333]">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-950 dark:text-[#f8fafc]">
              Vesper Modules
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-[#94a3b8]">
              Enable built-in capabilities or define new slash-command functions.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modules"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:bg-[#292a2f] dark:hover:text-[#f8fafc]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="font-mono text-[11px] font-medium tracking-[0.06em] text-slate-600 dark:text-[#958ea0]">
                Custom Functions
              </h3>
              <button
                type="button"
                onClick={() => setShowAddForm((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-full border-t border-white/25 bg-gradient-to-r from-[#8b5cf6] to-[#7c3aed] px-3 py-1.5 text-xs font-medium text-white shadow-[0_0_16px_rgba(139,92,246,0.35)] transition-transform hover:brightness-110 active:scale-[0.97] whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Function</span>
              </button>
            </div>

            {showAddForm && (
              <form
                onSubmit={(e) => void handleCreate(e)}
                className="mb-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-[#1e2333] dark:bg-[#0f111a]"
              >
                {formError && (
                  <p className="text-xs text-red-600 dark:text-[#ffb4ab]">{formError}</p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="mod-name"
                      className="block text-xs font-medium text-slate-700 dark:text-[#cbc3d7]"
                    >
                      Function Name
                    </label>
                    <input
                      id="mod-name"
                      type="text"
                      maxLength={60}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Network Recon Guide"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#8b5cf6] focus:outline-none dark:border-[#1e2333] dark:bg-[#090a0f] dark:text-[#f8fafc]"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="mod-cmd"
                      className="block text-xs font-medium text-slate-700 dark:text-[#cbc3d7]"
                    >
                      Slash Command
                    </label>
                    <input
                      id="mod-cmd"
                      type="text"
                      maxLength={32}
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="/recon"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-[#8b5cf6] focus:outline-none dark:border-[#1e2333] dark:bg-[#090a0f] dark:text-[#4cd7f6]"
                    />
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="mod-desc"
                    className="block text-xs font-medium text-slate-700 dark:text-[#cbc3d7]"
                  >
                    Short Description
                  </label>
                  <input
                    id="mod-desc"
                    type="text"
                    maxLength={200}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What does this function help with?"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#8b5cf6] focus:outline-none dark:border-[#1e2333] dark:bg-[#090a0f] dark:text-[#f8fafc]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="mod-inst"
                    className="block text-xs font-medium text-slate-700 dark:text-[#cbc3d7]"
                  >
                    Function Behavior / Directive
                  </label>
                  <textarea
                    id="mod-inst"
                    rows={3}
                    maxLength={2000}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Tell Vesper how to behave when this module or slash command is used..."
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-900 focus:border-[#8b5cf6] focus:outline-none dark:border-[#1e2333] dark:bg-[#090a0f] dark:text-[#f8fafc]"
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:text-[#94a3b8] dark:hover:bg-[#1e2333]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-full bg-[#8b5cf6] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#7c3aed] disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Function'}
                  </button>
                </div>
              </form>
            )}

            {customModules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-4 text-center text-xs text-slate-500 dark:border-[#1e2333] dark:text-[#64748b]">
                No custom functions added yet. Click &ldquo;Add Function&rdquo; to extend Vesper.
              </p>
            ) : (
              <div className="space-y-2">
                {customModules.map((mod) => renderModuleCard(mod, true))}
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-2.5 font-mono text-[11px] font-medium tracking-[0.06em] text-slate-600 dark:text-[#958ea0]">
              Built-in Security &amp; IT Modules
            </h3>
            <div className="space-y-2">
              {builtInModules.map((mod) => renderModuleCard(mod, false))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
