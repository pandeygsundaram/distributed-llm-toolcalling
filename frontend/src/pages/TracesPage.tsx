import { Activity } from "lucide-react";

export function TracesPage() {
  return (
    <div className="flex-1 bg-[#0d0d0d] flex flex-col items-center justify-center gap-3 text-center px-8">
      <Activity size={32} className="text-slate-700" />
      <p className="text-slate-400 text-sm font-medium">Select a conversation from the sidebar</p>
      <p className="text-slate-600 text-xs max-w-xs">
        Click any chat session on the left to view its full execution trace — tool calls, inputs, outputs, and timings.
      </p>
    </div>
  );
}
