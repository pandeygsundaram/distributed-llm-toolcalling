import { FileText, Check, X } from "lucide-react";

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  filePath: string;
  content: string;
  sessionId: string;
  createdAt: string;
}

interface Props {
  request: ApprovalRequest;
  onRespond: (approvalId: string, approved: boolean) => void;
}

export function ApprovalModal({ request, onRespond }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] bg-[#141414] border border-[#2a2a2a] rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#2a2a2a] bg-amber-950/20">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-700/40 flex items-center justify-center">
            <FileText size={15} className="text-amber-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-amber-300">Write Permission Required</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Agent wants to write a file in the sandbox</div>
          </div>
        </div>

        {/* File path */}
        <div className="px-5 py-3 border-b border-[#1e1e1e]">
          <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-1">Target file</div>
          <div className="font-mono text-sm text-slate-200 bg-[#1a1a1a] border border-[#252525] rounded-lg px-3 py-2">
            /sandbox/{request.filePath}
          </div>
        </div>

        {/* Content preview */}
        <div className="px-5 py-3 border-b border-[#1e1e1e]">
          <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-1">Content to write</div>
          <pre className="font-mono text-xs text-slate-300 bg-[#0d0d0d] border border-[#252525] rounded-lg px-3 py-2.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">
            {request.content}
          </pre>
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-5 py-4">
          <button
            onClick={() => onRespond(request.approvalId, false)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-red-800/50 bg-red-950/30 text-red-400 text-sm hover:bg-red-950/50 transition-colors"
          >
            <X size={14} />
            Reject
          </button>
          <button
            onClick={() => onRespond(request.approvalId, true)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-emerald-700/50 bg-emerald-950/30 text-emerald-400 text-sm hover:bg-emerald-950/50 transition-colors"
          >
            <Check size={14} />
            Approve Write
          </button>
        </div>
      </div>
    </div>
  );
}
